/* ============================================================
   server/ui-server.js — Séç Proxy v2.0
   UI server + High-Performance Reverse Proxy Browser Engine

   ARCHITECTURE — how the built-in browser works:
   ─────────────────────────────────────────────────────────
   Old approach (broken): srcdoc iframe
     - No real origin → cookies fail, relative URLs fail
     - JS fetch/XHR breaks (CORS), WebSockets fail
     - Assets don't load, sites render blank or broken

   New approach (this file): Transparent Reverse Proxy
     - Browser tab contains a FULL-PAGE iframe at /rp/?t=<url>
     - /rp/ endpoint fetches the real page, rewrites ALL URLs
       (href, src, action, srcset, CSS url(), JS location, etc.)
       so they point back to /rp/?t=<absolute-url>
     - iframe has a REAL origin (127.0.0.1:3000) so:
       • Cookies are set correctly and persist across requests
       • Relative URLs resolve correctly
       • JS runs in a consistent origin context
       • Forms submit correctly
       • Navigation stays inside the iframe
     - ALL traffic (page + assets + XHR + forms) routes through
       proxy.js:8080 for full capture, intercept, and scanning
     - Session cookies stored server-side per browsing session
       so login/auth state persists across page loads
   ─────────────────────────────────────────────────────────
   ============================================================ */
'use strict';

const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const zlib    = require('zlib');
const net     = require('net');
const crypto  = require('crypto');
const { URL } = require('url');

const UI_PORT    = parseInt(process.env.UI_PORT    || '3000', 10);
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '8080', 10);
const UI_ROOT    = path.join(__dirname, '..', 'ui');
const RP_PREFIX  = '/rp/';      // reverse-proxy path prefix
const RP_PARAM   = 't';         // query param holding the real target URL

// ── MIME types ────────────────────────────────────────────────
const MIME = {
  '.html':'text/html; charset=utf-8', '.css':'text/css',
  '.js':'application/javascript',    '.json':'application/json',
  '.png':'image/png',   '.jpg':'image/jpeg',  '.jpeg':'image/jpeg',
  '.gif':'image/gif',   '.svg':'image/svg+xml','.ico':'image/x-icon',
  '.woff':'font/woff',  '.woff2':'font/woff2', '.ttf':'font/ttf',
  '.mp4':'video/mp4',   '.webm':'video/webm',  '.mp3':'audio/mpeg',
  '.crt':'application/x-x509-ca-cert',
};

const FAVICON = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

// ── Session cookie jar (server-side) ─────────────────────────
// Maps sessionId → Map<host, cookieString>
// Cookies are kept per-host so sites get their own cookie context.
const cookieJar = new Map();

function getSessionCookies(sessionId, host) {
  if (!cookieJar.has(sessionId)) cookieJar.set(sessionId, new Map());
  return cookieJar.get(sessionId).get(host) || '';
}

function setSessionCookies(sessionId, host, setCookieHeaders) {
  if (!cookieJar.has(sessionId)) cookieJar.set(sessionId, new Map());
  const jar = cookieJar.get(sessionId);
  const existing = {};
  // Parse existing
  const cur = jar.get(host) || '';
  if (cur) {
    cur.split('; ').forEach(pair => {
      const [k, ...vparts] = pair.split('=');
      if (k) existing[k.trim()] = vparts.join('=');
    });
  }
  // Merge new
  const newCookies = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  for (const hdr of newCookies) {
    if (!hdr) continue;
    // Only take the name=value part (strip path/expires/etc)
    const nameVal = hdr.split(';')[0].trim();
    const eq = nameVal.indexOf('=');
    if (eq > 0) {
      const k = nameVal.slice(0, eq).trim();
      const v = nameVal.slice(eq + 1).trim();
      if (v === '' || v.toLowerCase() === 'deleted') delete existing[k];
      else existing[k] = v;
    }
  }
  const cookieStr = Object.entries(existing).map(([k,v]) => `${k}=${v}`).join('; ');
  jar.set(host, cookieStr);
}

// ── Helpers ───────────────────────────────────────────────────
function decompress(buf, enc) {
  return new Promise(res => {
    if (!enc || !buf.length) return res(buf);
    const e = enc.toLowerCase();
    const cb = (er, r) => res(er ? buf : r);
    if      (e.includes('br'))      zlib.brotliDecompress(buf, cb);
    else if (e.includes('gzip'))    zlib.gunzip(buf, cb);
    else if (e.includes('deflate')) zlib.inflate(buf, cb);
    else res(buf);
  });
}

function collectBody(req) {
  return new Promise(res => {
    const c = [];
    req.on('data', d => c.push(d));
    req.on('end',  () => res(Buffer.concat(c)));
    req.on('error',() => res(Buffer.alloc(0)));
  });
}

function serveStatic(filePath, res) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('404'); return; }
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache', 'Content-Length': data.length });
    res.end(data);
  });
}

function forwardToProxyAPI(clientReq, clientRes, body) {
  const opts = {
    hostname: '127.0.0.1', port: PROXY_PORT,
    path: clientReq.url, method: clientReq.method,
    headers: { ...clientReq.headers, host: `127.0.0.1:${PROXY_PORT}` },
  };
  const req = http.request(opts, proxyRes => {
    const h = { ...proxyRes.headers, 'Access-Control-Allow-Origin':'*' };
    clientRes.writeHead(proxyRes.statusCode, h);
    proxyRes.pipe(clientRes);
  });
  req.on('error', e => {
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, {'Content-Type':'application/json'});
      clientRes.end(JSON.stringify({ error: e.message }));
    }
  });
  if (body && body.length) req.write(body);
  req.end();
}

// ── Fetch through proxy.js (for full capture) ─────────────────
function fetchViaProxy(method, targetUrl, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error(`Timed out after ${timeoutMs/1000}s — ${targetUrl.hostname}`)); }
    }, timeoutMs || 30000);

    const opts = {
      hostname: '127.0.0.1',
      port:     PROXY_PORT,
      path:     targetUrl.href,   // proxy protocol: absolute URL as path
      method:   method || 'GET',
      headers,
    };

    const req = http.request(opts, res => {
      const chunks = [];
      res.on('data',  c => chunks.push(c));
      res.on('error', e => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
      res.on('end', async () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          const raw = Buffer.concat(chunks);
          // proxy.js already decompresses — but double-check
          const enc = res.headers['content-encoding'] || '';
          const buf = enc ? await decompress(raw, enc) : raw;
          resolve({ status: res.statusCode, headers: res.headers, buf });
        } catch(e) { reject(e); }
      });
    });

    req.setTimeout(timeoutMs || 30000, () => {
      req.destroy();
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error('Socket timeout')); }
    });
    req.on('error', e => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });

    if (body && body.length) req.write(body);
    req.end();
  });
}

// ── Build /rp/ URL for a target URL ──────────────────────────
function rpUrl(targetHref, currentBase) {
  try {
    const abs = currentBase ? new URL(targetHref, currentBase).href : new URL(targetHref).href;
    return `${RP_PREFIX}?${RP_PARAM}=${encodeURIComponent(abs)}`;
  } catch (_) { return targetHref; }
}

// ── URL rewriter: convert attr value → /rp/?t=<abs> ─────────
function rewriteAttrUrl(val, base) {
  if (!val) return val;
  const v = val.trim();
  if (!v || v.startsWith('#') || v.startsWith('javascript:') ||
      v.startsWith('mailto:') || v.startsWith('tel:') ||
      v.startsWith('data:') || v.startsWith('blob:')) return val;
  return rpUrl(v, base);
}

// ── Rewrite srcset attribute ──────────────────────────────────
function rewriteSrcset(srcset, base) {
  return srcset.replace(/([^\s,]+)(\s+[^\s,]+)?/g, (m, url, descriptor) => {
    return rewriteAttrUrl(url, base) + (descriptor || '');
  });
}

// ── CSS url() rewriter ────────────────────────────────────────
function rewriteCSS(css, base) {
  return css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, q, u) => {
    return `url(${q}${rewriteAttrUrl(u, base)}${q})`;
  });
}

// ── Rewrite @import in CSS ────────────────────────────────────
function rewriteCSSImports(css, base) {
  return rewriteCSS(
    css.replace(/@import\s+(["'])([^"']+)\1/gi, (m, q, u) => `@import ${q}${rewriteAttrUrl(u, base)}${q}`)
       .replace(/@import\s+url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, q, u) => `@import url(${q}${rewriteAttrUrl(u, base)}${q})`),
    base
  );
}

// ── JavaScript rewriter ───────────────────────────────────────
// Injects a runtime shim that intercepts location changes, fetch,
// XMLHttpRequest, and window.open so in-page navigation stays proxied.
function buildJSShim(base, sessionId) {
  return `
(function(){
  var _BASE = ${JSON.stringify(base)};
  var _RP   = ${JSON.stringify(RP_PREFIX + '?' + RP_PARAM + '=')};
  var _SID  = ${JSON.stringify(sessionId)};

  function toRp(u){
    if(!u) return u;
    var s = String(u).trim();
    if(s.startsWith('#')||s.startsWith('javascript:')||s.startsWith('mailto:')||s.startsWith('data:')||s.startsWith('blob:')) return s;
    try{ return _RP + encodeURIComponent(new URL(s,_BASE).href); }catch(_){ return s; }
  }
  function fromRp(u){
    try{
      var url=new URL(u,location.href);
      if(url.pathname.startsWith('/rp/')){
        var t=url.searchParams.get('t');
        return t||u;
      }
    }catch(_){}
    return u;
  }

  // Patch fetch
  var _F=window.fetch;
  window.fetch=function(input,init){
    var url=(typeof input==='string')?input:(input&&input.url?input.url:'');
    try{
      var abs=new URL(url,_BASE).href;
      if(!abs.startsWith(location.origin)){
        var proxied=_RP+encodeURIComponent(abs);
        if(typeof input==='string') return _F(proxied,init);
        return _F(Object.assign({},input,{url:proxied}),init);
      }
    }catch(e){}
    return _F(input,init);
  };

  // Patch XMLHttpRequest
  var _XHR=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(method,url){
    var args=Array.from(arguments);
    try{
      var abs=new URL(String(url),_BASE).href;
      if(!abs.startsWith(location.origin)) args[1]=_RP+encodeURIComponent(abs);
    }catch(e){}
    return _XHR.apply(this,args);
  };

  // Patch location.assign / replace / href
  try{
    var locProto=Object.getPrototypeOf(location);
    var _assign=locProto.assign;
    locProto.assign=function(u){ return _assign.call(this,toRp(u)); };
    var _replace=locProto.replace;
    locProto.replace=function(u){ return _replace.call(this,toRp(u)); };
    Object.defineProperty(locProto,'href',{
      get:function(){ return fromRp(location.toString()); },
      set:function(u){ location.assign(toRp(u)); },
    });
  }catch(e){}

  // Patch window.open
  var _open=window.open;
  window.open=function(url,name,features){
    return _open.call(this,toRp(url),name,features);
  };

  // Patch history.pushState / replaceState
  var _push=history.pushState.bind(history);
  history.pushState=function(s,t,u){ return _push(s,t,u?toRp(u):u); };
  var _repl=history.replaceState.bind(history);
  history.replaceState=function(s,t,u){ return _repl(s,t,u?toRp(u):u); };

  // Expose real URL for the browser chrome
  window.__PROXY_REAL_URL__ = _BASE;
  window.addEventListener('load',function(){
    try{ parent.postMessage({type:'rp-title',title:document.title,url:_BASE},'*'); }catch(e){}
  });
  new MutationObserver(function(){
    try{ parent.postMessage({type:'rp-title',title:document.title,url:_BASE},'*'); }catch(e){}
  }).observe(document.querySelector('title')||document.head,{childList:true,subtree:true,characterData:true});
})();
`;
}

// ── Rewrite full HTML document ────────────────────────────────
function rewriteHTML(html, base, sessionId) {
  // Remove existing base tags
  html = html.replace(/<base\b[^>]*>/gi, '');

  // Inject our base tag + JS shim at top of <head>
  const shimScript = `<script>${buildJSShim(base, sessionId)}<\/script>`;
  const baseTag    = `<base href="${base}">`;
  const inject     = baseTag + shimScript;

  if (/<head\b[^>]*>/i.test(html)) {
    html = html.replace(/(<head\b[^>]*>)/i, '$1' + inject);
  } else if (/<html\b[^>]*>/i.test(html)) {
    html = html.replace(/(<html\b[^>]*>)/i, '$1<head>' + inject + '</head>');
  } else {
    html = inject + html;
  }

  // Rewrite tag attributes
  // href on <a>, <area>, <link rel=stylesheet/icon>
  html = html.replace(/(<(?:a|area)\b[^>]*)\shref=(["'])([^"']*)\2/gi, (m, pre, q, u) => {
    return `${pre} href=${q}${rewriteAttrUrl(u, base)}${q}`;
  });
  html = html.replace(/(<link\b[^>]*)\shref=(["'])([^"']*)\2/gi, (m, pre, q, u) => {
    return `${pre} href=${q}${rewriteAttrUrl(u, base)}${q}`;
  });
  // src on <script>, <img>, <source>, <video>, <audio>, <iframe>, <embed>
  html = html.replace(/(<(?:script|img|source|video|audio|iframe|embed|input)\b[^>]*)\ssrc=(["'])([^"']*)\2/gi, (m, pre, q, u) => {
    return `${pre} src=${q}${rewriteAttrUrl(u, base)}${q}`;
  });
  // action on <form>
  html = html.replace(/(<form\b[^>]*)\saction=(["'])([^"']*)\2/gi, (m, pre, q, u) => {
    return `${pre} action=${q}${rewriteAttrUrl(u, base)}${q}`;
  });
  // srcset
  html = html.replace(/\ssrcset=(["'])([^"']+)\1/gi, (m, q, val) => {
    return ` srcset=${q}${rewriteSrcset(val, base)}${q}`;
  });
  // data-src (lazy load)
  html = html.replace(/\sdata-src=(["'])([^"']*)\1/gi, (m, q, u) => {
    return ` data-src=${q}${rewriteAttrUrl(u, base)}${q}`;
  });
  // poster on video
  html = html.replace(/(<video\b[^>]*)\sposter=(["'])([^"']*)\2/gi, (m, pre, q, u) => {
    return `${pre} poster=${q}${rewriteAttrUrl(u, base)}${q}`;
  });
  // Inline style url()
  html = html.replace(/(\sstyle=(["']))((?:(?!\2).)*)\2/gi, (m, pre, q, style) => {
    return pre + rewriteCSS(style, base) + q;
  });
  // <style> blocks
  html = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, open, css, close) => {
    return open + rewriteCSSImports(css, base) + close;
  });
  // meta refresh
  html = html.replace(/(content=["'][0-9]+;\s*url=)([^"']+)(["'])/gi, (m, pre, u, q) => {
    return pre + rewriteAttrUrl(u, base) + q;
  });

  return html;
}

// ── Headers to strip from origin responses ───────────────────
const STRIP_HEADERS = new Set([
  'content-security-policy', 'content-security-policy-report-only',
  'x-frame-options', 'strict-transport-security',
  'content-encoding', 'transfer-encoding', 'content-length',
  'alt-svc', 'expect-ct',
]);

// ── Strip headers not to forward to origin ───────────────────
const STRIP_REQ_HEADERS = new Set([
  'host', 'connection', 'proxy-connection',
  'upgrade-insecure-requests',
]);

// ── Main reverse proxy handler ────────────────────────────────
async function handleRP(req, res) {
  const reqUrl    = new URL(req.url, `http://127.0.0.1:${UI_PORT}`);
  const targetRaw = reqUrl.searchParams.get(RP_PARAM);

  if (!targetRaw) {
    res.writeHead(400); res.end('Missing target URL'); return;
  }

  let targetUrl;
  try { targetUrl = new URL(decodeURIComponent(targetRaw)); }
  catch (_) {
    res.writeHead(400); res.end('Invalid target URL: ' + targetRaw); return;
  }

  // ── Session management ────────────────────────────────────
  let sessionId = '';
  const cookieHdr = req.headers['cookie'] || '';
  const sidMatch  = cookieHdr.match(/(?:^|;\s*)_rp_sid=([^;]+)/);
  if (sidMatch) {
    sessionId = sidMatch[1];
  } else {
    sessionId = crypto.randomBytes(16).toString('hex');
  }

  const body   = await collectBody(req);
  const method = req.method || 'GET';

  // Build forwarded headers — correct host, session cookies merged in
  const savedCookies   = getSessionCookies(sessionId, targetUrl.hostname);
  const incomingCookies = cookieHdr.replace(/(?:^|;\s*)_rp_sid=[^;]+/g, '').trim();
  const mergedCookies  = [savedCookies, incomingCookies].filter(Boolean).join('; ');

  const fwdHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!STRIP_REQ_HEADERS.has(k.toLowerCase())) fwdHeaders[k] = v;
  }
  fwdHeaders['host']                      = targetUrl.host;
  fwdHeaders['connection']                = 'close';
  fwdHeaders['accept-encoding']           = 'gzip, deflate, br';
  fwdHeaders['upgrade-insecure-requests'] = '1';
  if (mergedCookies) fwdHeaders['cookie'] = mergedCookies;

  let result;
  try {
    result = await fetchViaProxy(method, targetUrl, fwdHeaders, body.length ? body : null, 30000);
  } catch (e) {
    const errHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Error</title></head>
<body style="font-family:monospace;background:#0a0c0f;color:#e2e8f0;padding:32px;margin:0;">
<h2 style="color:#ef4444;">⚠ Connection Failed</h2>
<p style="color:#94a3b8;margin-top:8px;">${e.message}</p>
<p style="color:#64748b;margin-top:4px;font-size:12px;">Target: ${targetUrl.href}</p>
<p style="margin-top:20px;"><button onclick="history.back()" style="background:#1e293b;border:1px solid #334155;color:#e2e8f0;padding:6px 14px;border-radius:4px;cursor:pointer;">← Go Back</button></p>
</body></html>`;
    res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(Buffer.byteLength(errHtml)), 'Access-Control-Allow-Origin': '*' });
    res.end(errHtml);
    return;
  }

  // ── Handle Set-Cookie ─────────────────────────────────────
  const setCookieHdrs = result.headers['set-cookie'];
  if (setCookieHdrs) {
    const arr = Array.isArray(setCookieHdrs) ? setCookieHdrs : [setCookieHdrs];
    setSessionCookies(sessionId, targetUrl.hostname, arr);
  }

  // ── Handle redirects — rewrite Location header ────────────
  const status = result.status;
  if ([301,302,303,307,308].includes(status) && result.headers['location']) {
    try {
      const loc    = new URL(result.headers['location'], targetUrl.href).href;
      const newLoc = `${RP_PREFIX}?${RP_PARAM}=${encodeURIComponent(loc)}`;
      const resHdrs = buildResHeaders(result.headers, 0, sessionId);
      resHdrs['location'] = newLoc;
      res.writeHead(status, resHdrs);
      res.end();
      return;
    } catch (_) {}
  }

  // ── Build clean response headers ──────────────────────────
  function buildResHeaders(originHdrs, bodyLen, sid) {
    const out = {};
    for (const [k, v] of Object.entries(originHdrs)) {
      const kl = k.toLowerCase();
      if (!STRIP_HEADERS.has(kl) && kl !== 'set-cookie' && kl !== 'location') out[k] = v;
    }
    if (bodyLen >= 0) out['content-length'] = String(bodyLen);
    out['access-control-allow-origin']  = '*';
    out['access-control-allow-headers'] = '*';
    out['cache-control']                = 'no-store';
    // Set our session cookie
    out['set-cookie'] = `_rp_sid=${sid}; Path=/; HttpOnly; SameSite=Lax`;
    return out;
  }

  const ct = (result.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  let buf  = result.buf;

  // ── Rewrite HTML ──────────────────────────────────────────
  if (ct === 'text/html' || ct === 'application/xhtml+xml') {
    let html = buf.toString('utf8');
    html = rewriteHTML(html, targetUrl.href, sessionId);
    buf  = Buffer.from(html, 'utf8');
    const hdrs = buildResHeaders(result.headers, buf.length, sessionId);
    hdrs['content-type'] = 'text/html; charset=utf-8';
    res.writeHead(status, hdrs);
    res.end(buf);
    return;
  }

  // ── Rewrite CSS ───────────────────────────────────────────
  if (ct === 'text/css') {
    let css = buf.toString('utf8');
    css = rewriteCSSImports(css, targetUrl.href);
    buf = Buffer.from(css, 'utf8');
    const hdrs = buildResHeaders(result.headers, buf.length, sessionId);
    hdrs['content-type'] = 'text/css';
    res.writeHead(status, hdrs);
    res.end(buf);
    return;
  }

  // ── Rewrite JS — inject shim at top ──────────────────────
  if (ct === 'application/javascript' || ct === 'text/javascript') {
    const shim = buildJSShim(targetUrl.href, sessionId);
    buf = Buffer.concat([Buffer.from(shim + '\n', 'utf8'), buf]);
    const hdrs = buildResHeaders(result.headers, buf.length, sessionId);
    hdrs['content-type'] = 'application/javascript';
    res.writeHead(status, hdrs);
    res.end(buf);
    return;
  }

  // ── Binary assets — serve as-is ──────────────────────────
  const hdrs = buildResHeaders(result.headers, buf.length, sessionId);
  // Restore content-type
  if (result.headers['content-type']) hdrs['content-type'] = result.headers['content-type'];
  res.writeHead(status, hdrs);
  res.end(buf);
}

// ── Main server ───────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://127.0.0.1:${UI_PORT}`);
  const pathname  = parsedUrl.pathname;

  res.on('error', () => {});

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'*', 'Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS' });
    res.end(); return;
  }
  if (pathname === '/favicon.ico') {
    res.writeHead(200, { 'Content-Type':'image/png', 'Content-Length':FAVICON.length });
    res.end(FAVICON); return;
  }

  // Reverse proxy — all /rp/* requests
  if (pathname.startsWith(RP_PREFIX) || pathname === '/rp') {
    await handleRP(req, res); return;
  }

  // API forward to proxy.js
  if (pathname.startsWith('/api/')) {
    const body = await collectBody(req);
    forwardToProxyAPI(req, res, body); return;
  }

  // Static UI files
  let filePath = path.join(UI_ROOT, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(UI_ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  if (!path.extname(filePath)) {
    filePath = fs.existsSync(filePath + '.html') ? filePath + '.html' : path.join(UI_ROOT, 'index.html');
  }
  serveStatic(filePath, res);
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`[UI-Server] Port ${UI_PORT} in use.`);
  else console.error('[UI-Server]', e.message);
  process.exit(1);
});

server.listen(UI_PORT, '127.0.0.1', () => {
  console.log(`[UI-Server] Serving on http://127.0.0.1:${UI_PORT}`);
  console.log(`[UI-Server] Reverse proxy browser at /rp/?t=<url>`);
  console.log(`[UI-Server] API forwarding → http://127.0.0.1:${PROXY_PORT}`);
});

process.on('SIGINT',  () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
