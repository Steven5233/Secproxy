/* ============================================================
   server/proxy.js — Séç Proxy v2.0 (Browser Build)

   THREE separate servers:
     PROXY_PORT (8080) — pure HTTP forward proxy (optional — still
                         works for traditional proxy mode)
     API_PORT   (8888) — REST API for the UI
     WS_PORT    (8081) — WebSocket bridge to UI

   NEW in this build:
     POST /api/browser/fetch  — server-side fetch so the built-in
       browser tab can load any URL without needing a proxy config
       on the device. Android makes zero proxy changes; the Node
       process does all the network work.

   Architecture: Zero-config Android usage
     1. Run: node server/proxy.js
     2. Open http://127.0.0.1:3000 in your Android browser
     3. Use the "Browser" tab — it fetches via the server, no
        proxy config needed whatsoever.
   ============================================================ */
'use strict';

require('events').EventEmitter.defaultMaxListeners = 50;

const http      = require('http');
const https     = require('https');
const zlib      = require('zlib');
const fs        = require('fs');
const os        = require('os');

const db        = require('./db');
const bridge    = require('./ws-bridge');
const intercept = require('./intercept');
const mitm      = require('./mitm');
const scanner   = require('./scanner');
const ca        = require('./ca');

const PROXY_PORT = parseInt(process.env.PROXY_PORT || '8080', 10);
const API_PORT   = parseInt(process.env.API_PORT   || '8888', 10);
const WS_PORT    = parseInt(process.env.WS_PORT    || '8081', 10);

const stats = {
  total: 0, intercepted: 0, errors: 0,
  bytesIn: 0, bytesOut: 0, startedAt: Date.now(),
};

// ── Helpers ──────────────────────────────────────────────────
function decompress(buf, enc) {
  return new Promise(res => {
    if (!enc) return res(buf);
    const e = enc.toLowerCase();
    if (e.includes('gzip'))    return zlib.gunzip(buf,           (er, r) => res(er ? buf : r));
    if (e.includes('deflate')) return zlib.inflate(buf,          (er, r) => res(er ? buf : r));
    if (e.includes('br'))      return zlib.brotliDecompress(buf, (er, r) => res(er ? buf : r));
    res(buf);
  });
}

function collectBody(req) {
  return new Promise(res => {
    const c = [];
    req.on('data',  d => c.push(d));
    req.on('end',   () => res(Buffer.concat(c)));
    req.on('error', () => res(Buffer.alloc(0)));
  });
}

function getLanIP() {
  const nets = os.networkInterfaces();
  for (const ifaces of Object.values(nets))
    for (const i of ifaces)
      if (i.family === 'IPv4' && !i.internal) return i.address;
  return '127.0.0.1';
}

function corsHeaders() {
  return {
    'Content-Type':                'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':'*',
    'Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS',
  };
}

function sendJSON(res, data, status = 200) {
  const json = JSON.stringify(data);
  res.writeHead(status, corsHeaders());
  res.end(json);
}

// ── Forward plain HTTP to origin ─────────────────────────────
function forwardHTTP(reqObj, clientRes) {
  return new Promise(resolve => {
    let parsed;
    try { parsed = new URL(reqObj.url); }
    catch (_) {
      try { clientRes.writeHead(400); clientRes.end('Bad URL'); } catch (_) {}
      return resolve({ status: 400, headers: {}, body: '', latency_ms: 0 });
    }

    const isHTTPS = parsed.protocol === 'https:';
    const lib     = isHTTPS ? https : http;
    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHTTPS ? 443 : 80),
      path:     (parsed.pathname || '/') + (parsed.search || ''),
      method:   reqObj.method,
      headers:  { ...reqObj.headers },
      rejectUnauthorized: false,
    };
    delete opts.headers['proxy-connection'];
    delete opts.headers['proxy-authorization'];

    const t0  = Date.now();
    const req = lib.request(opts, async originRes => {
      const chunks = [];
      originRes.on('data', c => chunks.push(c));
      originRes.on('end',  async () => {
        const raw  = Buffer.concat(chunks);
        const buf  = await decompress(raw, originRes.headers['content-encoding']);
        const body = buf.toString('utf8');
        const rh   = {};
        for (const [k, v] of Object.entries(originRes.headers)) rh[k] = v;
        delete rh['content-encoding'];
        rh['content-length'] = String(buf.length);
        try { clientRes.writeHead(originRes.statusCode, rh); clientRes.end(buf); } catch (_) {}
        resolve({ status: originRes.statusCode, headers: rh, body, latency_ms: Date.now() - t0 });
      });
      originRes.on('error', () => resolve({ status: 0, headers: {}, body: '', latency_ms: Date.now() - t0 }));
    });

    req.on('error', e => {
      stats.errors++;
      try { clientRes.writeHead(502); clientRes.end(`Séç Proxy: ${e.message}`); } catch (_) {}
      resolve({ status: 502, headers: {}, body: e.message, latency_ms: Date.now() - t0 });
    });

    if (reqObj.body) req.write(reqObj.body);
    req.end();
  });
}

// ── Server-side browser fetch (NEW — zero-config Android) ────
// The built-in browser tab calls this instead of making direct
// requests. Node does the HTTP work and returns the full response
// including body, headers, and status. No proxy config needed.
async function browserFetch(targetUrl, method, reqHeaders, reqBody) {
  return new Promise(resolve => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (_) {
      try { parsed = new URL('https://' + targetUrl); } catch (_) {
        return resolve({ status: 0, headers: {}, body: '', error: 'Invalid URL', latency_ms: 0, finalUrl: targetUrl });
      }
    }

    const isHTTPS = parsed.protocol === 'https:';
    const lib     = isHTTPS ? https : http;

    // Build safe forwarded headers — strip browser-only / hop-by-hop
    const fwdHeaders = {};
    const skip = new Set([
      'host','connection','keep-alive','proxy-connection','proxy-authorization',
      'te','trailers','transfer-encoding','upgrade',
      // security headers the browser adds that we override
      'origin','referer',
    ]);
    for (const [k, v] of Object.entries(reqHeaders || {})) {
      if (!skip.has(k.toLowerCase())) fwdHeaders[k] = v;
    }
    fwdHeaders['host'] = parsed.hostname;
    // Appear as a real browser
    if (!fwdHeaders['user-agent']) {
      fwdHeaders['user-agent'] = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
    }
    if (!fwdHeaders['accept']) {
      fwdHeaders['accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
    }
    fwdHeaders['accept-encoding'] = 'gzip, deflate, br';

    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHTTPS ? 443 : 80),
      path:     (parsed.pathname || '/') + (parsed.search || ''),
      method:   method || 'GET',
      headers:  fwdHeaders,
      rejectUnauthorized: false,
      timeout: 20000,
    };

    const t0 = Date.now();
    const req = lib.request(opts, async originRes => {
      // Handle redirects (up to 5 hops) — transparently follow them
      if ([301,302,303,307,308].includes(originRes.statusCode)) {
        const loc = originRes.headers['location'];
        if (loc) {
          let nextUrl;
          try {
            nextUrl = new URL(loc, targetUrl).href;
          } catch (_) {
            nextUrl = loc;
          }
          // Drain response body so socket is freed
          originRes.resume();
          // Recurse with GET for 301/302/303, preserve method for 307/308
          const nextMethod = [307,308].includes(originRes.statusCode) ? method : 'GET';
          const nextBody   = [307,308].includes(originRes.statusCode) ? reqBody : null;
          const result = await browserFetch(nextUrl, nextMethod, reqHeaders, nextBody);
          // Merge latency
          result.latency_ms = (result.latency_ms || 0) + (Date.now() - t0);
          result.finalUrl   = result.finalUrl || nextUrl;
          return resolve(result);
        }
      }

      const chunks = [];
      originRes.on('data', c => chunks.push(c));
      originRes.on('end',  async () => {
        const raw  = Buffer.concat(chunks);
        const buf  = await decompress(raw, originRes.headers['content-encoding']);

        // Determine content type
        const ct   = (originRes.headers['content-type'] || '').toLowerCase();
        const isBinary = /image|audio|video|octet-stream|font|woff|zip|pdf/.test(ct);

        let body, base64Body;
        if (isBinary) {
          base64Body = buf.toString('base64');
          body = '';
        } else {
          body = buf.toString('utf8');
        }

        const rh = {};
        for (const [k, v] of Object.entries(originRes.headers)) rh[k] = v;
        delete rh['content-encoding'];
        rh['content-length'] = String(buf.length);

        resolve({
          status:     originRes.statusCode,
          headers:    rh,
          body,
          base64Body: base64Body || null,
          isBinary,
          contentType: ct,
          latency_ms: Date.now() - t0,
          finalUrl:   targetUrl,
        });
      });
      originRes.on('error', () => resolve({
        status: 0, headers: {}, body: '', error: 'Response read error',
        latency_ms: Date.now() - t0, finalUrl: targetUrl,
      }));
    });

    req.setTimeout(20000, () => {
      req.destroy();
      resolve({ status: 0, headers: {}, body: '', error: 'Timeout (20s)', latency_ms: Date.now() - t0, finalUrl: targetUrl });
    });

    req.on('error', e => {
      resolve({ status: 0, headers: {}, body: '', error: e.message, latency_ms: Date.now() - t0, finalUrl: targetUrl });
    });

    if (reqBody) req.write(reqBody);
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════
//  SERVER 1 — PURE PROXY on PROXY_PORT (8080)
//  Kept for optional traditional proxy mode / desktop use.
//  Android users use the built-in browser instead.
// ══════════════════════════════════════════════════════════════
const proxyServer = http.createServer(async (clientReq, clientRes) => {
  clientReq.socket.setMaxListeners(50);
  clientRes.setMaxListeners(50);
  if (!clientReq.socket._secErrorBound) {
    clientReq.socket._secErrorBound = true;
    clientReq.socket.on('error', () => {});
  }
  clientRes.on('error', () => {});

  const reqUrl = clientReq.url || '/';
  stats.total++;

  // Direct visit to proxy port → info page
  if (!reqUrl.startsWith('http://') && !reqUrl.startsWith('https://')) {
    const hostHeader = (clientReq.headers['host'] || '');
    if (hostHeader.startsWith('127.0.0.1') || hostHeader.startsWith('localhost')) {
      const page = `<!DOCTYPE html><html><head><title>Séç Proxy</title>
<style>body{background:#0a0c0f;color:#00ff9d;font-family:monospace;text-align:center;padding:40px}
h1{font-size:2em;letter-spacing:4px}p{color:#7a8fa8}code{background:#1e242d;padding:2px 8px;border-radius:3px}</style>
</head><body>
<h1>Séç Proxy v2.0</h1>
<p>Proxy is running on port <code>${PROXY_PORT}</code></p>
<p>Open the UI at <a href="http://127.0.0.1:3000" style="color:#00ff9d">http://127.0.0.1:3000</a></p>
<p>Use the <b>Browser</b> tab — no proxy config needed!</p>
<p>Or set device proxy to <code>127.0.0.1:${PROXY_PORT}</code> to capture all traffic.</p>
</body></html>`;
      try {
        clientRes.writeHead(200, { 'Content-Type': 'text/html' });
        clientRes.end(page);
      } catch (_) {}
      return;
    }
    const fullHost = clientReq.headers['host'] || 'localhost';
    clientReq.url = `http://${fullHost}${reqUrl}`;
  }

  const currentUrl = clientReq.url || '/';
  let fullUrl;
  if (currentUrl.startsWith('http://') || currentUrl.startsWith('https://')) {
    fullUrl = currentUrl;
  } else {
    const hostHeader = clientReq.headers['host'] || 'localhost';
    fullUrl = `http://${hostHeader}${currentUrl}`;
  }

  const bodyBuf = await collectBody(clientReq);
  const bodyStr = bodyBuf.length ? bodyBuf.toString('utf8') : '';

  const headers = {};
  for (const [k, v] of Object.entries(clientReq.headers)) headers[k] = v;

  let parsed;
  try { parsed = new URL(fullUrl); }
  catch (_) { parsed = { hostname: 'unknown', port: 80, pathname: '/', search: '', protocol: 'http:' }; }

  let reqObj = {
    method:  clientReq.method,
    scheme:  parsed.protocol.replace(':', ''),
    host:    parsed.hostname,
    port:    parseInt(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)),
    path:    (parsed.pathname || '/') + (parsed.search || ''),
    url:     fullUrl,
    headers,
    body:    bodyStr,
  };

  reqObj = intercept.applyMR(reqObj, 'request');

  let finalReq = reqObj;
  try {
    const result = await intercept.pause(reqObj);
    if (result.action === 'drop') {
      stats.intercepted++;
      try { clientRes.writeHead(200); clientRes.end('Dropped by Séç Proxy.'); } catch (_) {}
      return;
    }
    finalReq = result.request;
    if (intercept.enabled) stats.intercepted++;
  } catch (_) {}

  let reqId;
  try {
    reqId = db.insertRequest(finalReq);
    bridge.emitRequest({
      id:          reqId,
      method:      finalReq.method,
      scheme:      finalReq.scheme,
      host:        finalReq.host,
      port:        finalReq.port,
      path:        finalReq.path,
      url:         finalReq.url,
      req_headers: finalReq.headers,
      req_body:    finalReq.body,
    });
  } catch (e) {
    console.error('[Proxy] DB insert error:', e.message);
  }

  const resObj = await forwardHTTP(finalReq, clientRes);
  const modRes = intercept.applyMR(resObj, 'response');

  try {
    if (reqId != null) {
      db.updateResponse(reqId, modRes);
      stats.bytesOut += (finalReq.body || '').length;
      stats.bytesIn  += (modRes.body  || '').length;
      const full = db.getById(reqId);
      const hits = scanner.scan(full);
      if (hits.length) {
        hits.forEach(h => db.addHit({ request_id: reqId, ...h }));
        bridge.emitScannerHit(reqId, hits);
      }
      bridge.emitResponse({
        id:          reqId,
        res_status:  modRes.status,
        res_headers: modRes.headers,
        res_body:    modRes.body,
        latency_ms:  modRes.latency_ms,
      });
    }
  } catch (e) {
    console.error('[Proxy] DB update error:', e.message);
  }
  bridge.emitStats(stats);
});

proxyServer.on('connect', (req, socket, head) => {
  stats.total++;
  socket.setMaxListeners(50);
  if (!socket._secErrorBound) {
    socket._secErrorBound = true;
    socket.on('error', () => {});
  }
  const parts    = (req.url || '').split(':');
  const hostname = parts[0];
  const port     = parseInt(parts[1] || '443', 10);
  mitm.handleConnect(socket, hostname, port);
});

proxyServer.on('clientError', (err, socket) => {
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (_) {}
});

proxyServer.on('error', e => {
  if (e.code === 'EADDRINUSE')
    console.error(`[Proxy] Port ${PROXY_PORT} already in use. Try: PROXY_PORT=8082 node server/proxy.js`);
  else
    console.error('[Proxy] Error:', e.message);
  process.exit(1);
});

// ══════════════════════════════════════════════════════════════
//  SERVER 2 — REST API on API_PORT (8888)
//  Includes the new /api/browser/fetch endpoint.
// ══════════════════════════════════════════════════════════════
const apiServer = http.createServer(async (req, res) => {
  req.socket.setMaxListeners(50);
  if (!req.socket._secErrorBound) {
    req.socket._secErrorBound = true;
    req.socket.on('error', () => {});
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders()); res.end(); return;
  }

  const pathname = (req.url || '/').split('?')[0];
  const body     = (await collectBody(req)).toString('utf8');
  handleAPI(pathname, req.method, body, res);
});

apiServer.on('error', e => {
  if (e.code === 'EADDRINUSE')
    console.error(`[API] Port ${API_PORT} already in use. Try: API_PORT=8889 node server/proxy.js`);
  else
    console.error('[API] Error:', e.message);
});

// ── REST API handler ──────────────────────────────────────────
async function handleAPI(pathname, method, bodyStr, res) {
  let body = {};
  try { body = JSON.parse(bodyStr || '{}'); } catch (_) {}

  // ── NEW: Built-in browser server-side fetch ──────────────
  // POST /api/browser/fetch
  //   { url, method?, headers?, body? }
  // Returns full response captured and logged to history.
  if (method === 'POST' && pathname === '/api/browser/fetch') {
    const { url: targetUrl, method: m = 'GET', headers: h = {}, body: b = null } = body;
    if (!targetUrl) return sendJSON(res, { error: 'url required' }, 400);

    let parsed;
    try {
      parsed = new URL(targetUrl.startsWith('http') ? targetUrl : 'https://' + targetUrl);
    } catch (_) {
      return sendJSON(res, { error: 'invalid url' }, 400);
    }

    // Build reqObj to log to DB / intercept
    let reqObj = {
      method:  m.toUpperCase(),
      scheme:  parsed.protocol.replace(':', ''),
      host:    parsed.hostname,
      port:    parseInt(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)),
      path:    (parsed.pathname || '/') + (parsed.search || ''),
      url:     parsed.href,
      headers: h,
      body:    b || '',
      source:  'browser', // mark as coming from built-in browser
    };

    // Apply match-replace on request
    reqObj = intercept.applyMR(reqObj, 'request');

    // Intercept pause
    let finalReq = reqObj;
    let intercepted = false;
    try {
      const result = await intercept.pause(reqObj);
      if (result.action === 'drop') {
        stats.intercepted++;
        return sendJSON(res, { status: 0, headers: {}, body: '', error: 'Dropped by intercept', latency_ms: 0 });
      }
      finalReq = result.request;
      if (intercept.enabled) { stats.intercepted++; intercepted = true; }
    } catch (_) {}

    // Log to DB
    stats.total++;
    let reqId;
    try {
      reqId = db.insertRequest(finalReq);
      bridge.emitRequest({
        id:          reqId,
        method:      finalReq.method,
        scheme:      finalReq.scheme,
        host:        finalReq.host,
        port:        finalReq.port,
        path:        finalReq.path,
        url:         finalReq.url,
        req_headers: finalReq.headers,
        req_body:    finalReq.body,
        source:      'browser',
      });
    } catch (e) {
      console.error('[API/browser] DB insert error:', e.message);
    }

    // Perform server-side fetch
    const fetchResult = await browserFetch(finalReq.url, finalReq.method, finalReq.headers, finalReq.body);

    // Apply match-replace on response
    const modRes = intercept.applyMR(fetchResult, 'response');

    // Update DB
    try {
      if (reqId != null) {
        db.updateResponse(reqId, {
          status:     modRes.status,
          headers:    modRes.headers,
          body:       modRes.body,
          latency_ms: modRes.latency_ms,
        });
        stats.bytesOut += (finalReq.body || '').length;
        stats.bytesIn  += (modRes.body  || '').length;

        const full = db.getById(reqId);
        const hits = scanner.scan(full);
        if (hits.length) {
          hits.forEach(h => db.addHit({ request_id: reqId, ...h }));
          bridge.emitScannerHit(reqId, hits);
        }
        bridge.emitResponse({
          id:          reqId,
          res_status:  modRes.status,
          res_headers: modRes.headers,
          res_body:    modRes.body,
          latency_ms:  modRes.latency_ms,
        });
      }
    } catch (e) {
      console.error('[API/browser] DB update error:', e.message);
    }

    bridge.emitStats(stats);
    return sendJSON(res, { ...modRes, reqId });
  }

  // ── Requests ────────────────────────────────────────────────
  if (method === 'GET'  && pathname === '/api/requests')         return sendJSON(res, db.list(1000));
  if (method === 'GET'  && /^\/api\/requests\/\d+$/.test(pathname)) {
    const id = parseInt(pathname.split('/')[3]);
    const r  = db.getById(id);
    if (!r) return sendJSON(res, { error: 'not found' }, 404);
    return sendJSON(res, { ...r, scanner_hits: db.hitsFor(id) });
  }
  if (method === 'POST' && pathname === '/api/requests/clear') { db.clearAll(); return sendJSON(res, { ok: true }); }
  if (method === 'POST' && pathname === '/api/search')         return sendJSON(res, db.search(body.q || ''));

  // ── Repeater ────────────────────────────────────────────────
  if (method === 'POST' && pathname === '/api/repeat') {
    const { method: m, url: u, headers: h = {}, body: b } = body;
    if (!u) return sendJSON(res, { error: 'url required' }, 400);
    const t0 = Date.now();
    let pUrl;
    try { pUrl = new URL(u); } catch (_) { try { pUrl = new URL('https://' + u); } catch (_) { return sendJSON(res, { error: 'bad url' }, 400); } }
    const isHTTPS = pUrl.protocol === 'https:';
    const lib     = isHTTPS ? https : http;
    const result  = await new Promise(resolve => {
      const opts = {
        hostname: pUrl.hostname,
        port:     pUrl.port || (isHTTPS ? 443 : 80),
        path:     (pUrl.pathname || '/') + (pUrl.search || ''),
        method:   m || 'GET', headers: h,
        rejectUnauthorized: false,
      };
      const req = lib.request(opts, async r => {
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('end',  async () => {
          const raw = Buffer.concat(chunks);
          const buf = await decompress(raw, r.headers['content-encoding']);
          const rh  = {};
          for (const [k, v] of Object.entries(r.headers)) rh[k] = v;
          resolve({ status: r.statusCode, headers: rh, body: buf.toString('utf8'), latency: Date.now() - t0 });
        });
      });
      req.on('error', e => resolve({ status: 0, headers: {}, body: e.message, latency: Date.now() - t0 }));
      if (b) req.write(b);
      req.end();
    });
    return sendJSON(res, result);
  }

  // ── Intercept ───────────────────────────────────────────────
  if (method === 'GET'  && pathname === '/api/intercept/status')      return sendJSON(res, { enabled: intercept.enabled, pending: intercept.listPending() });
  if (method === 'POST' && pathname === '/api/intercept/toggle')      { intercept.setEnabled(!intercept.enabled); bridge.emitStatus({ intercept: intercept.enabled }); return sendJSON(res, { enabled: intercept.enabled }); }
  if (method === 'POST' && pathname === '/api/intercept/forward')     return sendJSON(res, { ok: intercept.forward(body.id, body.request) });
  if (method === 'POST' && pathname === '/api/intercept/drop')        return sendJSON(res, { ok: intercept.drop(body.id) });
  if (method === 'POST' && pathname === '/api/intercept/forward-all') { intercept.forwardAll(); return sendJSON(res, { ok: true }); }

  // ── Rules ────────────────────────────────────────────────────
  if (method === 'GET'    && pathname === '/api/rules')                      return sendJSON(res, db.listRules());
  if (method === 'POST'   && pathname === '/api/rules')                      { db.addRule(body); return sendJSON(res, { ok: true }); }
  if (method === 'DELETE' && /^\/api\/rules\/\d+$/.test(pathname))          { db.deleteRule(parseInt(pathname.split('/')[3])); return sendJSON(res, { ok: true }); }
  if (method === 'GET'    && pathname === '/api/mr-rules')                   return sendJSON(res, db.listMR());
  if (method === 'POST'   && pathname === '/api/mr-rules')                   { db.addMR(body); return sendJSON(res, { ok: true }); }
  if (method === 'DELETE' && /^\/api\/mr-rules\/\d+$/.test(pathname))       { db.deleteMR(parseInt(pathname.split('/')[3])); return sendJSON(res, { ok: true }); }

  // ── Saved ────────────────────────────────────────────────────
  if (method === 'GET'    && pathname === '/api/saved')                      return sendJSON(res, db.listSaved());
  if (method === 'POST'   && pathname === '/api/saved')                      { db.saveRequest(body); return sendJSON(res, { ok: true }); }
  if (method === 'DELETE' && /^\/api\/saved\/\d+$/.test(pathname))          { db.deleteSaved(parseInt(pathname.split('/')[3])); return sendJSON(res, { ok: true }); }

  // ── Stats & info ─────────────────────────────────────────────
  if (method === 'GET' && pathname === '/api/stats')  return sendJSON(res, { ...stats, uptime: Date.now() - stats.startedAt });
  if (method === 'GET' && pathname === '/api/ca.crt') {
    try {
      const buf = fs.readFileSync(ca.caCertDerPath);
      res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="secproxy-ca.crt"', 'Content-Length': buf.length, 'Access-Control-Allow-Origin': '*' });
      return res.end(buf);
    } catch (_) { return sendJSON(res, { error: 'CA cert not found' }, 404); }
  }
  if (method === 'GET' && pathname === '/api/info') {
    return sendJSON(res, { proxyHost: getLanIP(), proxyPort: PROXY_PORT, apiPort: API_PORT, wsPort: WS_PORT });
  }

  sendJSON(res, { error: 'not found' }, 404);
}

// ── Wire intercept events → WS ────────────────────────────────
intercept.on('paused',    ({ id, request }) => { stats.intercepted++; bridge.emitIntercepted(id, request); });
intercept.on('forwarded', ({ id })          => bridge.emitInterceptDone(id, 'forward'));
intercept.on('dropped',   ({ id })          => bridge.emitInterceptDone(id, 'drop'));

// ── Boot ──────────────────────────────────────────────────────
db.init().then(() => {

  proxyServer.listen(PROXY_PORT, '0.0.0.0', () => {
    console.log(`[Proxy] Listening on 0.0.0.0:${PROXY_PORT}`);
  });

  apiServer.listen(API_PORT, '127.0.0.1', () => {
    console.log(`[API]   Listening on 127.0.0.1:${API_PORT}`);
  });

  bridge.start(WS_PORT);

  const lanIP = getLanIP();
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║         Séç Proxy v2.0 — Browser Build              ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  Proxy  → 0.0.0.0:${PROXY_PORT}  (${lanIP})`.padEnd(55) + '║');
  console.log(`║  API    → 127.0.0.1:${API_PORT}`.padEnd(55) + '║');
  console.log(`║  WS     → ws://0.0.0.0:${WS_PORT}`.padEnd(55) + '║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log('║  ANDROID (zero-config):                              ║');
  console.log('║    Open http://127.0.0.1:3000 → use Browser tab     ║');
  console.log('║    No proxy config needed at all!                    ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log('║  TRADITIONAL PROXY (optional):                       ║');
  console.log(`║    Host: 127.0.0.1   Port: ${PROXY_PORT}`.padEnd(55) + '║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');

}).catch(e => {
  console.error('[Proxy] DB init failed:', e.message);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n[Proxy] Shutting down...');
  db.close();
  process.exit(0);
});
