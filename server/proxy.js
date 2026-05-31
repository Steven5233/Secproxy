/* ============================================================
   proxy.js — Main proxy server
   Séç Proxy v2.0

   Starts two servers:
     :8080  — HTTP proxy listener (forward proxy)
     :8081  — WebSocket bridge   (handled by ws-bridge.js)
     :8080/api/* — REST API for the UI (piggy-backed on same port)

   Browser/device → proxy → internet
   ============================================================ */

'use strict';

const http      = require('http');
const net       = require('net');
const url       = require('url');
const zlib      = require('zlib');
const fs        = require('fs');
const path      = require('path');

const db        = require('./db');
const bridge    = require('./ws-bridge');
const intercept = require('./intercept');
const mitm      = require('./mitm');
const scanner   = require('./scanner');
const ca        = require('./ca');

const PROXY_PORT = parseInt(process.env.PROXY_PORT || '8080', 10);
const WS_PORT    = parseInt(process.env.WS_PORT    || '8081', 10);

/* ── Stats counters ──────────────────────────────────────── */
let stats = {
  total: 0, intercepted: 0, errors: 0,
  bytesIn: 0, bytesOut: 0,
  startedAt: Date.now(),
};

/* ── Decompress response body if gzip/deflate ───────────── */
function decompress(buffer, encoding) {
  return new Promise((resolve) => {
    if (!encoding) return resolve(buffer);
    const enc = encoding.toLowerCase();
    if (enc.includes('gzip')) {
      zlib.gunzip(buffer, (e, r) => resolve(e ? buffer : r));
    } else if (enc.includes('deflate')) {
      zlib.inflate(buffer, (e, r) => resolve(e ? buffer : r));
    } else if (enc.includes('br')) {
      zlib.brotliDecompress(buffer, (e, r) => resolve(e ? buffer : r));
    } else {
      resolve(buffer);
    }
  });
}

/* ── Collect request body ────────────────────────────────── */
function collectBody(incoming) {
  return new Promise((resolve) => {
    const chunks = [];
    incoming.on('data', c => chunks.push(c));
    incoming.on('end',  () => resolve(Buffer.concat(chunks)));
    incoming.on('error',() => resolve(Buffer.alloc(0)));
  });
}

/* ── Forward a plain HTTP request ────────────────────────── */
function forwardHTTP(reqObj, clientRes) {
  return new Promise((resolve) => {
    const parsed = url.parse(reqObj.url);
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || 80,
      path:     parsed.path || '/',
      method:   reqObj.method,
      headers:  { ...reqObj.headers },
    };

    // Remove proxy-specific headers
    delete options.headers['proxy-connection'];
    delete options.headers['proxy-authorization'];

    const t0  = Date.now();
    const req = http.request(options, async (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', async () => {
        const rawBody  = Buffer.concat(chunks);
        const encoding = res.headers['content-encoding'];
        const bodyBuf  = await decompress(rawBody, encoding);
        const bodyStr  = bodyBuf.toString('utf8');

        const resHeaders = {};
        for (const [k, v] of Object.entries(res.headers)) resHeaders[k] = v;

        // Remove content-encoding since we've already decoded
        delete resHeaders['content-encoding'];
        resHeaders['content-length'] = String(bodyBuf.length);

        // Forward to client
        clientRes.writeHead(res.statusCode, resHeaders);
        clientRes.end(bodyBuf);

        resolve({
          status:     res.statusCode,
          headers:    resHeaders,
          body:       bodyStr,
          latency_ms: Date.now() - t0,
        });
      });
    });

    req.on('error', (e) => {
      try {
        clientRes.writeHead(502);
        clientRes.end(`Séç Proxy: upstream error — ${e.message}`);
      } catch (_) {}
      resolve({ status: 502, headers: {}, body: e.message, latency_ms: Date.now() - t0 });
    });

    if (reqObj.body) req.write(reqObj.body);
    req.end();
  });
}

/* ── REST API handler (served on same port as proxy) ─────── */
async function handleAPI(pathname, method, body, res) {
  const send = (data, status = 200) => {
    const json = JSON.stringify(data);
    res.writeHead(status, {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers':'*',
      'Access-Control-Allow-Methods':'*',
    });
    res.end(json);
  };

  let parsed = {};
  try { parsed = JSON.parse(body || '{}'); } catch (_) {}

  /* ── Requests ── */
  if (pathname === '/api/requests' && method === 'GET') {
    return send(db.list(500));
  }
  if (pathname.startsWith('/api/requests/') && method === 'GET') {
    const id = parseInt(pathname.split('/')[3]);
    const r  = db.getById(id);
    if (!r) return send({ error: 'not found' }, 404);
    const hits = db.getHitsForRequest(id);
    return send({ ...r, scanner_hits: hits });
  }
  if (pathname === '/api/requests/search' && method === 'GET') {
    return send({ error: 'use POST' }, 400);
  }
  if (pathname === '/api/search' && method === 'POST') {
    return send(db.search(parsed.q || ''));
  }
  if (pathname === '/api/requests/clear' && method === 'POST') {
    db.clearAll();
    return send({ ok: true });
  }

  /* ── Repeater ── */
  if (pathname === '/api/repeat' && method === 'POST') {
    const { method: m, url: u, headers, body: b } = parsed;
    if (!u) return send({ error: 'url required' }, 400);
    const t0 = Date.now();
    const result = await new Promise((resolve) => {
      const pUrl = url.parse(u);
      const isHTTPS = pUrl.protocol === 'https:';
      const opts = {
        hostname: pUrl.hostname,
        port:     pUrl.port || (isHTTPS ? 443 : 80),
        path:     pUrl.path || '/',
        method:   m || 'GET',
        headers:  headers || {},
      };
      const lib = isHTTPS ? require('https') : http;
      const req = lib.request(opts, async (r) => {
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('end', async () => {
          const raw = Buffer.concat(chunks);
          const dec = await decompress(raw, r.headers['content-encoding']);
          const rh  = {};
          for (const [k, v] of Object.entries(r.headers)) rh[k] = v;
          resolve({
            status: r.statusCode, headers: rh,
            body: dec.toString('utf8'), latency: Date.now() - t0,
          });
        });
      });
      req.on('error', e => resolve({ status: 0, headers: {}, body: e.message, latency: Date.now() - t0 }));
      if (b) req.write(b);
      req.end();
    });
    return send(result);
  }

  /* ── Intercept control ── */
  if (pathname === '/api/intercept/status' && method === 'GET') {
    return send({ enabled: intercept.enabled, pending: intercept.listPending() });
  }
  if (pathname === '/api/intercept/toggle' && method === 'POST') {
    intercept.setEnabled(!intercept.enabled);
    bridge.emitStatus({ intercept: intercept.enabled });
    return send({ enabled: intercept.enabled });
  }
  if (pathname === '/api/intercept/forward' && method === 'POST') {
    const ok = intercept.forward(parsed.id, parsed.request);
    return send({ ok });
  }
  if (pathname === '/api/intercept/drop' && method === 'POST') {
    const ok = intercept.drop(parsed.id);
    return send({ ok });
  }
  if (pathname === '/api/intercept/forward-all' && method === 'POST') {
    intercept.forwardAll();
    return send({ ok: true });
  }

  /* ── Rules ── */
  if (pathname === '/api/rules' && method === 'GET') {
    return send(db.listRules());
  }
  if (pathname === '/api/rules' && method === 'POST') {
    db.addRule(parsed);
    return send({ ok: true });
  }
  if (pathname.startsWith('/api/rules/') && method === 'DELETE') {
    db.deleteRule(parseInt(pathname.split('/')[3]));
    return send({ ok: true });
  }

  /* ── Match-Replace rules ── */
  if (pathname === '/api/mr-rules' && method === 'GET') {
    return send(db.listMRRules());
  }
  if (pathname === '/api/mr-rules' && method === 'POST') {
    db.addMRRule(parsed);
    return send({ ok: true });
  }
  if (pathname.startsWith('/api/mr-rules/') && method === 'DELETE') {
    db.deleteMRRule(parseInt(pathname.split('/')[3]));
    return send({ ok: true });
  }

  /* ── Saved requests ── */
  if (pathname === '/api/saved' && method === 'GET') {
    return send(db.listSaved());
  }
  if (pathname === '/api/saved' && method === 'POST') {
    db.saveRequest(parsed);
    return send({ ok: true });
  }
  if (pathname.startsWith('/api/saved/') && method === 'DELETE') {
    db.deleteSaved(parseInt(pathname.split('/')[3]));
    return send({ ok: true });
  }

  /* ── Stats ── */
  if (pathname === '/api/stats' && method === 'GET') {
    return send({ ...stats, uptime: Date.now() - stats.startedAt });
  }

  /* ── CA cert download ── */
  if (pathname === '/api/ca.crt' && method === 'GET') {
    try {
      const certBuf = fs.readFileSync(ca.caCertDerPath);
      res.writeHead(200, {
        'Content-Type':        'application/x-x509-ca-cert',
        'Content-Disposition': 'attachment; filename="secproxy-ca.crt"',
        'Content-Length':      certBuf.length,
      });
      return res.end(certBuf);
    } catch (_) {
      return send({ error: 'CA cert not found' }, 404);
    }
  }

  /* ── QR proxy info ── */
  if (pathname === '/api/info' && method === 'GET') {
    const { networkInterfaces } = require('os');
    const nets = networkInterfaces();
    const ips  = [];
    for (const ifaces of Object.values(nets)) {
      for (const iface of ifaces) {
        if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
      }
    }
    return send({ proxyHost: ips[0] || '127.0.0.1', proxyPort: PROXY_PORT, wsPort: WS_PORT });
  }

  send({ error: 'not found' }, 404);
}

/* ── Main HTTP server ────────────────────────────────────── */
const server = http.createServer(async (clientReq, clientRes) => {
  const reqUrl = clientReq.url || '/';

  /* ── CORS preflight ── */
  if (clientReq.method === 'OPTIONS') {
    clientRes.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': '*',
    });
    return clientRes.end();
  }

  /* ── API requests from UI ── */
  if (reqUrl.startsWith('/api/')) {
    const body = (await collectBody(clientReq)).toString('utf8');
    return handleAPI(reqUrl.split('?')[0], clientReq.method, body, clientRes);
  }

  /* ── Proxy request ── */
  stats.total++;

  const parsedUrl = url.parse(reqUrl);
  const host  = parsedUrl.hostname || (clientReq.headers['host'] || '').split(':')[0];
  const port  = parsedUrl.port || 80;
  const scheme = 'http';

  const bodyBuf = await collectBody(clientReq);
  const bodyStr = bodyBuf.length ? bodyBuf.toString('utf8') : '';

  const headers = {};
  for (const [k, v] of Object.entries(clientReq.headers)) headers[k] = v;

  let reqObj = {
    method:  clientReq.method,
    scheme,
    host,
    port:    parseInt(port),
    path:    parsedUrl.path || '/',
    url:     reqUrl.startsWith('http') ? reqUrl : `http://${host}${parsedUrl.path || '/'}`,
    headers,
    body:    bodyStr,
  };

  /* Apply request match-replace */
  reqObj = intercept.applyMatchReplace(reqObj, 'request');

  /* Pause for intercept if enabled */
  let finalReq = reqObj;
  try {
    const result = await intercept.pause(reqObj);
    if (result.action === 'drop') {
      stats.intercepted++;
      clientRes.writeHead(200);
      clientRes.end('Request dropped by Séç Proxy intercept.');
      return;
    }
    finalReq = result.request;
    if (intercept.enabled) stats.intercepted++;
  } catch (_) {}

  /* Store request */
  const reqId = db.insertRequest(finalReq);
  bridge.emitRequest({
    id: reqId, ...finalReq,
    req_headers: finalReq.headers,
    req_body:    finalReq.body,
  });

  /* Forward to origin */
  const resObj = await forwardHTTP(finalReq, clientRes);

  /* Apply response match-replace */
  const modRes = intercept.applyMatchReplace(resObj, 'response');

  /* Store response */
  db.updateResponse(reqId, modRes);
  stats.bytesOut += (finalReq.body || '').length;
  stats.bytesIn  += (modRes.body   || '').length;

  /* Passive scan */
  const fullEntry = db.getById(reqId);
  const hits = scanner.scan(fullEntry);
  if (hits.length) {
    hits.forEach(h => db.addScannerHit({ request_id: reqId, ...h }));
    bridge.emitScannerHit(reqId, hits);
  }

  bridge.emitResponse({ id: reqId, ...modRes });
  bridge.emitStats(stats);
});

/* ── CONNECT handler for HTTPS MITM ─────────────────────── */
server.on('connect', (req, clientSocket, head) => {
  const [hostname, portStr] = (req.url || '').split(':');
  const port = parseInt(portStr || '443', 10);
  stats.total++;

  mitm.handleConnect(clientSocket, hostname, port, head);
});

/* ── Intercept events → WS bridge ───────────────────────── */
intercept.on('paused',    ({ id, request }) => {
  stats.intercepted++;
  bridge.emitIntercepted(id, request);
});
intercept.on('forwarded', ({ id }) => bridge.emitInterceptResolved(id, 'forward'));
intercept.on('dropped',   ({ id }) => bridge.emitInterceptResolved(id, 'drop'));

/* ── Start ───────────────────────────────────────────────── */
server.listen(PROXY_PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║          Séç Proxy v2.0 — RUNNING           ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  HTTP Proxy  →  0.0.0.0:${PROXY_PORT}                ║`);
  console.log(`║  WS Bridge   →  ws://0.0.0.0:${WS_PORT}            ║`);
  console.log(`║  UI API      →  http://127.0.0.1:${PROXY_PORT}/api   ║`);
  console.log('╠══════════════════════════════════════════════╣');
  console.log('║  Set browser proxy:  127.0.0.1:8080         ║');
  console.log('║  Install CA cert:    /api/ca.crt             ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
  bridge.start(WS_PORT);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[Proxy] Port ${PROXY_PORT} is in use. Try: PROXY_PORT=8082 node server/proxy.js`);
  } else {
    console.error('[Proxy] Server error:', e.message);
  }
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n[Proxy] Shutting down...');
  db.close();
  process.exit(0);
});
