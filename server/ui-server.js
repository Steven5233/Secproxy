/* ============================================================
   server/ui-server.js — Séç Proxy v2.0
   UI static file server + built-in browser fetch endpoint.

   .
   ============================================================ */
'use strict';

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const zlib  = require('zlib');
const net   = require('net');
const tls   = require('tls');

const UI_PORT    = parseInt(process.env.UI_PORT    || '3000', 10);
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '8080', 10);
const UI_ROOT    = path.join(__dirname, '..', 'ui');

// ── MIME types ────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.crt':  'application/x-x509-ca-cert',
  '.pem':  'application/x-pem-file',
  '.txt':  'text/plain',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
};

// Tiny 1×1 transparent PNG favicon
const FAVICON = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

// ── Helpers ───────────────────────────────────────────────────
function decompress(buf, enc) {
  return new Promise(res => {
    if (!enc || !buf.length) return res(buf);
    const e  = enc.toLowerCase();
    const cb = (er, r) => res(er ? buf : r);
    if      (e.includes('br'))      zlib.brotliDecompress(buf, cb);
    else if (e.includes('gzip'))    zlib.gunzip(buf, cb);
    else if (e.includes('deflate')) zlib.inflate(buf, cb);
    else res(buf);
  });
}

function collectBody(req) {
  return new Promise(resolve => {
    const c = [];
    req.on('data',  d => c.push(d));
    req.on('end',   () => resolve(Buffer.concat(c)));
    req.on('error', () => resolve(Buffer.alloc(0)));
  });
}

// ── Headers to strip from upstream responses ─────────────────
const STRIP_RES_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'content-encoding',
  'transfer-encoding',
  'content-length',
  'strict-transport-security',
]);

function buildRespHeaders(originHeaders, bodyLength, extras) {
  const out = {};
  for (const [k, v] of Object.entries(originHeaders || {})) {
    if (!STRIP_RES_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  out['content-length']               = String(bodyLength);
  out['access-control-allow-origin']  = '*';
  out['access-control-allow-headers'] = '*';
  out['access-control-allow-methods'] = 'GET,POST,PUT,DELETE,OPTIONS';
  Object.assign(out, extras || {});
  return out;
}

// ── Forward to proxy API ──────────────────────────────────────
function forwardToProxy(clientReq, clientRes, reqBody) {
  const options = {
    hostname: '127.0.0.1',
    port:     PROXY_PORT,
    path:     clientReq.url,
    method:   clientReq.method,
    headers:  { ...clientReq.headers, host: `127.0.0.1:${PROXY_PORT}` },
  };
  const proxyReq = http.request(options, proxyRes => {
    const headers = {
      ...proxyRes.headers,
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    };
    if (clientReq.url === '/api/ca.crt') {
      headers['Content-Type']        = 'application/x-x509-ca-cert';
      headers['Content-Disposition'] = 'attachment; filename="secproxy-ca.crt"';
    }
    clientRes.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(clientRes);
  });
  proxyReq.on('error', err => {
    console.error(`[UI-Server] Proxy forward error: ${err.message}`);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: 'Could not reach proxy server', message: err.message }));
    }
  });
  if (reqBody && reqBody.length) proxyReq.write(reqBody);
  proxyReq.end();
}

// ── Serve static file ─────────────────────────────────────────
function serveStatic(filePath, clientRes) {
  fs.readFile(filePath, (err, data) => {
    if (err) { clientRes.writeHead(404); clientRes.end('404 Not Found'); return; }
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    clientRes.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache', 'Content-Length': data.length });
    clientRes.end(data);
  });
}

// ── FIX-B1/B2: Raw socket fetch via proxy with correct headers ─
// Sends request to proxy.js using HTTP proxy protocol (absolute URL
// as path). Fixes the host header issue and adds a hard timeout.
function fetchViaProxy(method, targetUrl, extraHeaders, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let settled = false;

    // Hard timeout independent of socket events
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error(`Request timed out after ${timeoutMs/1000}s`)); }
    }, timeoutMs);

    // FIX-B1: Build headers with the CORRECT host for the target,
    // not the browser's host (127.0.0.1:3000).
    const fwdHeaders = {
      'host':                      targetUrl.host,
      'user-agent':                'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      'accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'accept-language':           'en-US,en;q=0.5',
      'accept-encoding':           'gzip, deflate, br',
      'connection':                'close',
      'upgrade-insecure-requests': '1',
      ...extraHeaders,
    };

    // Use proxy protocol: absolute URL as path
    const opts = {
      hostname: '127.0.0.1',
      port:     PROXY_PORT,
      path:     targetUrl.href,          // absolute URL — proxy protocol
      method:   method || 'GET',
      headers:  fwdHeaders,
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
          // Decompress here because proxy.js already strips content-encoding
          // but the response piped back may still be compressed if the
          // proxy's decompress failed (defensive).
          const raw = Buffer.concat(chunks);
          const enc = res.headers['content-encoding'] || '';
          const buf = enc ? await decompress(raw, enc) : raw;
          resolve({ status: res.statusCode, headers: res.headers, buf, latency: Date.now() - t0 });
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', e => {
      if (!settled) { settled = true; clearTimeout(timer); reject(e); }
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error('Socket timeout')); }
    });

    if (body && body.length) req.write(body);
    req.end();
  });
}

// ── Follow redirects ──────────────────────────────────────────
async function fetchWithRedirects(startUrl, method, extraHeaders, body, maxRedirects, timeoutMs) {
  let urlObj    = startUrl;
  let reqMethod = method;
  let reqBody   = body;

  for (let i = 0; i <= maxRedirects; i++) {
    const result = await fetchViaProxy(reqMethod, urlObj, extraHeaders, reqBody, timeoutMs);
    const { status, headers } = result;

    if ([301, 302, 303, 307, 308].includes(status) && headers.location && i < maxRedirects) {
      if ([301, 302, 303].includes(status)) { reqMethod = 'GET'; reqBody = null; }
      try   { urlObj = new URL(headers.location, urlObj.href); }
      catch (_) { throw new Error('Invalid redirect location: ' + headers.location); }
      continue;
    }

    return { ...result, finalUrl: urlObj.href };
  }
  throw new Error('Too many redirects');
}

// ── /proxy-browse — main page fetch ──────────────────────────
async function handleProxyBrowse(parsedUrl, req, res) {
  const target = parsedUrl.searchParams.get('url');
  if (!target) {
    res.writeHead(400, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('Missing ?url= parameter');
    return;
  }

  let targetUrl;
  try { targetUrl = new URL(target); }
  catch (_) {
    res.writeHead(400, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('Invalid URL: ' + target);
    return;
  }

  const body   = await collectBody(req);
  const method = req.method || 'GET';

  // Pass through cookies and auth if provided by the browser tab
  const extra = {};
  if (req.headers['cookie'])        extra['cookie']        = req.headers['cookie'];
  if (req.headers['authorization']) extra['authorization'] = req.headers['authorization'];
  if (req.headers['content-type'])  extra['content-type']  = req.headers['content-type'];

  try {
    const result = await fetchWithRedirects(targetUrl, method, extra, body.length ? body : null, 10, 30000);
    const ct     = (result.headers['content-type'] || '').split(';')[0].trim();
    const buf    = result.buf;

    const respHeaders = buildRespHeaders(result.headers, buf.length, {
      'x-final-url':      result.finalUrl,
      'x-proxy-status':   String(result.status),
      'x-proxy-latency':  String(result.latency),
    });
    // Preserve original content-type (it was stripped above, re-add)
    if (ct) respHeaders['content-type'] = result.headers['content-type'];

    res.writeHead(result.status, respHeaders);
    res.end(buf);

  } catch (e) {
    console.error('[proxy-browse] Error:', e.message, 'target:', target);
    const errHtml = `<!DOCTYPE html><html><body style="font-family:monospace;background:#0a0c0f;color:#e2e8f0;padding:24px;">
<h2 style="color:#ef4444;margin-bottom:8px;">Connection Error</h2>
<p style="color:#94a3b8;">${e.message}</p>
<p style="color:#64748b;margin-top:4px;font-size:12px;">Target: ${target}</p>
</body></html>`;
    if (!res.headersSent) {
      res.writeHead(502, {
        'Content-Type':               'text/html; charset=utf-8',
        'Content-Length':             String(Buffer.byteLength(errHtml)),
        'Access-Control-Allow-Origin':'*',
      });
      res.end(errHtml);
    }
  }
}

// ── /proxy-asset — proxy a single asset (img/css/js/font) ────
// FIX-B3: The iframe srcdoc cannot load relative assets because they
// resolve against about:srcdoc. The injected page rewrites all asset
// URLs to /proxy-asset?url=... so they load through this endpoint.
async function handleProxyAsset(parsedUrl, req, res) {
  const target = parsedUrl.searchParams.get('url');
  if (!target) { res.writeHead(400); res.end('Missing url'); return; }

  let targetUrl;
  try { targetUrl = new URL(target); }
  catch (_) { res.writeHead(400); res.end('Invalid URL'); return; }

  try {
    const result = await fetchViaProxy('GET', targetUrl, {}, null, 15000);
    const ct = result.headers['content-type'] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type':               ct,
      'Content-Length':             String(result.buf.length),
      'Cache-Control':              'public, max-age=300',
      'Access-Control-Allow-Origin':'*',
    });
    res.end(result.buf);
  } catch (e) {
    res.writeHead(502); res.end('Asset load failed: ' + e.message);
  }
}

// ── Main server ───────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://127.0.0.1:${UI_PORT}`);
  const pathname  = parsedUrl.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    });
    res.end(); return;
  }

  if (pathname === '/favicon.ico') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': FAVICON.length });
    res.end(FAVICON); return;
  }

  if (pathname === '/proxy-browse') { await handleProxyBrowse(parsedUrl, req, res); return; }
  if (pathname === '/proxy-asset')  { await handleProxyAsset(parsedUrl, req, res);  return; }

  if (pathname.startsWith('/api/')) {
    const body = await collectBody(req);
    forwardToProxy(req, res, body); return;
  }

  let filePath = path.join(UI_ROOT, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(UI_ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  if (!path.extname(filePath)) {
    filePath = fs.existsSync(filePath + '.html') ? filePath + '.html' : path.join(UI_ROOT, 'index.html');
  }
  serveStatic(filePath, res);
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE')
    console.error(`[UI-Server] Port ${UI_PORT} in use. Try: UI_PORT=3001 node server/ui-server.js`);
  else
    console.error('[UI-Server] Error:', e.message);
  process.exit(1);
});

server.listen(UI_PORT, '127.0.0.1', () => {
  console.log(`[UI-Server] Serving ui/ on http://127.0.0.1:${UI_PORT}`);
  console.log(`[UI-Server] Forwarding /api/* → http://127.0.0.1:${PROXY_PORT}`);
  console.log(`[UI-Server] Built-in browser → http://127.0.0.1:${UI_PORT}/proxy-browse?url=https://example.com`);
  console.log(`[UI-Server] CA cert available at http://127.0.0.1:${UI_PORT}/api/ca.crt`);
});

process.on('SIGINT',  () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
