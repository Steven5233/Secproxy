/* ============================================================
   server/proxy.js — Séç Proxy v2.0
   
   TWO separate servers on TWO separate ports:
     PROXY_PORT (8080) — pure HTTP forward proxy ONLY
                         captures ALL browser traffic
     API_PORT   (8888) — REST API for the UI ONLY
                         never touched by browser traffic
     WS_PORT    (8081) — WebSocket bridge to UI

   .
   ============================================================ */
'use strict';

// Prevent MaxListenersExceededWarning on high-traffic proxy sockets
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
    if (e.includes('gzip'))     return zlib.gunzip(buf,            (er, r) => res(er ? buf : r));
    if (e.includes('deflate'))  return zlib.inflate(buf,           (er, r) => res(er ? buf : r));
    if (e.includes('br'))       return zlib.brotliDecompress(buf,  (er, r) => res(er ? buf : r));
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
    // Strip proxy-only headers
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

// ══════════════════════════════════════════════════════════════
//  SERVER 1 — PURE PROXY on PROXY_PORT (8080)
//  This server ONLY handles browser traffic.
//  It does NOT serve the API. Zero ambiguity.
// ══════════════════════════════════════════════════════════════
const proxyServer = http.createServer(async (clientReq, clientRes) => {
  // Increase max listeners on this socket to prevent warning
  clientReq.socket.setMaxListeners(50);
  clientRes.setMaxListeners(50);

  // Absorb socket errors silently (browser closed tab mid-request etc.)
  if (!clientReq.socket._secErrorBound) {
    clientReq.socket._secErrorBound = true;
    clientReq.socket.on('error', () => {});
  }
  clientRes.on('error', () => {});

  const reqUrl = clientReq.url || '/';
  stats.total++;

  // Build full URL — browser proxy requests always send absolute URLs
  // e.g.  GET http://example.com/path HTTP/1.1
  // If it's not absolute, the host header tells us where it's going
  let fullUrl;
  if (reqUrl.startsWith('http://') || reqUrl.startsWith('https://')) {
    fullUrl = reqUrl;
  } else {
    const hostHeader = clientReq.headers['host'] || 'localhost';
    fullUrl = `http://${hostHeader}${reqUrl}`;
  }

  // Collect body
  const bodyBuf = await collectBody(clientReq);
  const bodyStr = bodyBuf.length ? bodyBuf.toString('utf8') : '';

  // Copy headers
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

  // Apply match-replace on request
  reqObj = intercept.applyMR(reqObj, 'request');

  // Intercept pause (if enabled)
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

  // Store in DB
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

  // Forward to origin
  const resObj = await forwardHTTP(finalReq, clientRes);

  // Apply match-replace on response
  const modRes = intercept.applyMR(resObj, 'response');

  // Update DB
  try {
    if (reqId != null) {
      db.updateResponse(reqId, modRes);
      stats.bytesOut += (finalReq.body || '').length;
      stats.bytesIn  += (modRes.body  || '').length;

      // Passive scan
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

// HTTPS CONNECT → MITM
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

// Client errors (bad request format, etc.)
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
//  Only the Proxy UI talks to this. Browser never touches it.
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

  // Requests
  if (method === 'GET'  && pathname === '/api/requests')        return sendJSON(res, db.list(1000));
  if (method === 'GET'  && /^\/api\/requests\/\d+$/.test(pathname)) {
    const id = parseInt(pathname.split('/')[3]);
    const r  = db.getById(id);
    if (!r) return sendJSON(res, { error: 'not found' }, 404);
    return sendJSON(res, { ...r, scanner_hits: db.hitsFor(id) });
  }
  if (method === 'POST' && pathname === '/api/requests/clear') { db.clearAll(); return sendJSON(res, { ok: true }); }
  if (method === 'POST' && pathname === '/api/search')         return sendJSON(res, db.search(body.q || ''));

  // Repeater
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

  // Intercept
  if (method === 'GET'  && pathname === '/api/intercept/status')      return sendJSON(res, { enabled: intercept.enabled, pending: intercept.listPending() });
  if (method === 'POST' && pathname === '/api/intercept/toggle')      { intercept.setEnabled(!intercept.enabled); bridge.emitStatus({ intercept: intercept.enabled }); return sendJSON(res, { enabled: intercept.enabled }); }
  if (method === 'POST' && pathname === '/api/intercept/forward')     return sendJSON(res, { ok: intercept.forward(body.id, body.request) });
  if (method === 'POST' && pathname === '/api/intercept/drop')        return sendJSON(res, { ok: intercept.drop(body.id) });
  if (method === 'POST' && pathname === '/api/intercept/forward-all') { intercept.forwardAll(); return sendJSON(res, { ok: true }); }

  // Rules
  if (method === 'GET'    && pathname === '/api/rules')                      return sendJSON(res, db.listRules());
  if (method === 'POST'   && pathname === '/api/rules')                      { db.addRule(body); return sendJSON(res, { ok: true }); }
  if (method === 'DELETE' && /^\/api\/rules\/\d+$/.test(pathname))          { db.deleteRule(parseInt(pathname.split('/')[3])); return sendJSON(res, { ok: true }); }
  if (method === 'GET'    && pathname === '/api/mr-rules')                   return sendJSON(res, db.listMR());
  if (method === 'POST'   && pathname === '/api/mr-rules')                   { db.addMR(body); return sendJSON(res, { ok: true }); }
  if (method === 'DELETE' && /^\/api\/mr-rules\/\d+$/.test(pathname))       { db.deleteMR(parseInt(pathname.split('/')[3])); return sendJSON(res, { ok: true }); }

  // Saved
  if (method === 'GET'    && pathname === '/api/saved')                      return sendJSON(res, db.listSaved());
  if (method === 'POST'   && pathname === '/api/saved')                      { db.saveRequest(body); return sendJSON(res, { ok: true }); }
  if (method === 'DELETE' && /^\/api\/saved\/\d+$/.test(pathname))          { db.deleteSaved(parseInt(pathname.split('/')[3])); return sendJSON(res, { ok: true }); }

  // Stats & info
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

// ── Boot — wait for DB, then start both servers ───────────────
db.init().then(() => {

  // Start proxy server
  proxyServer.listen(PROXY_PORT, '0.0.0.0', () => {
    console.log(`[Proxy] Listening on 0.0.0.0:${PROXY_PORT}`);
  });

  // Start API server
  apiServer.listen(API_PORT, '127.0.0.1', () => {
    console.log(`[API]   Listening on 127.0.0.1:${API_PORT}`);
  });

  // Start WebSocket bridge
  bridge.start(WS_PORT);

  const lanIP = getLanIP();
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║           Séç Proxy v2.0 — RUNNING              ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Proxy  → 0.0.0.0:${PROXY_PORT}  (${lanIP})`);
  console.log(`║  API    → 127.0.0.1:${API_PORT}`);
  console.log(`║  WS     → ws://0.0.0.0:${WS_PORT}`);
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  Set browser proxy:');
  console.log(`║    Host: 127.0.0.1   Port: ${PROXY_PORT}`);
  console.log(`║  Also use for HTTPS: YES`);
  console.log('║  CA cert: visit UI → Settings → Download CA');
  console.log('╚══════════════════════════════════════════════════╝');
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
