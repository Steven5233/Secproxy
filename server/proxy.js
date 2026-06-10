/* ============================================================
   server/proxy.js — Main proxy server + REST API
   Séç Proxy v2.0

   ============================================================ */
'use strict';

const net       = require('net');
const tls       = require('tls');
const zlib      = require('zlib');
const fs        = require('fs');
const os        = require('os');
const http      = require('http');

const db        = require('./db');
const bridge    = require('./ws-bridge');
const intercept = require('./intercept');
const mitm      = require('./mitm');
const scanner   = require('./scanner');
const ca        = require('./ca');
const netsetup  = require('./netsetup');

const PROXY_PORT = parseInt(process.env.PROXY_PORT || '8080', 10);
const WS_PORT    = parseInt(process.env.WS_PORT    || '8081', 10);

const stats = { total:0, intercepted:0, errors:0, bytesIn:0, bytesOut:0, startedAt:Date.now() };

// HTTP status reason phrases
const STATUS_PHRASES = {
  100:'Continue', 101:'Switching Protocols',
  200:'OK', 201:'Created', 202:'Accepted', 204:'No Content', 206:'Partial Content',
  301:'Moved Permanently', 302:'Found', 303:'See Other', 304:'Not Modified',
  307:'Temporary Redirect', 308:'Permanent Redirect',
  400:'Bad Request', 401:'Unauthorized', 403:'Forbidden', 404:'Not Found',
  405:'Method Not Allowed', 408:'Request Timeout', 409:'Conflict',
  410:'Gone', 413:'Payload Too Large', 422:'Unprocessable Entity', 429:'Too Many Requests',
  500:'Internal Server Error', 502:'Bad Gateway', 503:'Service Unavailable', 504:'Gateway Timeout',
};
function reasonPhrase(s) { return STATUS_PHRASES[s] || 'Unknown'; }

// ── Helpers ───────────────────────────────────────────────────
// FIX-R4: Decompress returns a Promise always. On failure returns
// the original buffer so the caller always gets something usable.
function decompress(buf, enc) {
  return new Promise(resolve => {
    if (!enc || !buf.length) return resolve(buf);
    const e = enc.toLowerCase();
    const cb = (err, result) => resolve(err ? buf : result);
    if      (e.includes('br'))      zlib.brotliDecompress(buf, cb);
    else if (e.includes('gzip'))    zlib.gunzip(buf,            cb);
    else if (e.includes('deflate')) { zlib.inflate(buf, (err2, r2) => err2 ? zlib.inflateRaw(buf, (e3,r3) => resolve(e3 ? buf : r3)) : resolve(r2)); }
    else resolve(buf);
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
    'Content-Type':                 'application/json',
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  };
}

function sendJSON(res, data, status = 200) {
  res.writeHead(status, corsHeaders());
  res.end(JSON.stringify(data));
}

// ── Decode chunked transfer-encoded body ─────────────────────
function decodeChunked(buf) {
  const parts = [];
  let pos = 0;
  const raw = buf.toString('binary');
  while (pos < raw.length) {
    const nl = raw.indexOf('\r\n', pos);
    if (nl < 0) break;
    const size = parseInt(raw.slice(pos, nl).split(';')[0].trim(), 16);
    if (isNaN(size) || size === 0) break;
    const start = nl + 2;
    parts.push(buf.slice(start, start + size));
    pos = start + size + 2;
  }
  return parts.length ? Buffer.concat(parts) : buf;
}

// ── Parse a raw HTTP response buffer ─────────────────────────
// Does NOT use Node's http parser — safe against Content-Length +
// Transfer-Encoding dual-header responses.
function parseRawResponse(buf) {
  const raw = buf.toString('binary');
  const sep = raw.indexOf('\r\n\r\n');
  if (sep < 0) {
    return { status:502, statusText:'Bad Gateway', headers:{}, bodyBuf:buf, encoding:'' };
  }

  const head  = raw.slice(0, sep);
  const lines = head.split('\r\n');
  const m     = (lines[0] || '').match(/HTTP\/[\d.]+ (\d+)(?:\s+(.*))?/);
  const status     = m ? parseInt(m[1], 10) : 502;
  const statusText = (m && m[2]) ? m[2].trim() : reasonPhrase(status);

  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].indexOf(':');
    if (c < 0) continue;
    const key = lines[i].slice(0, c).trim().toLowerCase();
    const val = lines[i].slice(c + 1).trim();
    if (headers[key] !== undefined) {
      headers[key] = Array.isArray(headers[key]) ? [...headers[key], val] : [headers[key], val];
    } else {
      headers[key] = val;
    }
  }

  // Decode chunked framing first, then we'll decompress separately
  const isChunked = (headers['transfer-encoding'] || '').toLowerCase().includes('chunked');
  let bodyBuf = buf.slice(sep + 4);
  if (isChunked) bodyBuf = decodeChunked(bodyBuf);

  // Pull out content-encoding before stripping headers
  const encoding = headers['content-encoding'] || '';

  return { status, statusText, headers, bodyBuf, encoding };
}

// ── FIX-R4: Unified async response processor ─────────────────
// Called from both 'end' and 'close' socket events. Decompresses
// the body and strips conflicting headers before resolving.
async function processRawResponse(rawBuf, t0) {
  let parsed;
  try {
    parsed = parseRawResponse(rawBuf);
  } catch (_) {
    return {
      status: 502, statusText: 'Bad Gateway', headers: {},
      bodyBuf: rawBuf, body: '', latency_ms: Date.now() - t0,
    };
  }

  // FIX-R4: Always decompress — whether we got here via 'end' or 'close'
  let bodyBuf = parsed.bodyBuf;
  if (parsed.encoding) {
    try {
      bodyBuf = await decompress(parsed.bodyBuf, parsed.encoding);
    } catch (_) {
      // decompression failed — send raw, browser may handle it
      bodyBuf = parsed.bodyBuf;
    }
  }

  const body = bodyBuf.toString('utf8');

  // Clean up headers: remove encoding/framing headers, set correct length
  const headers = { ...parsed.headers };
  delete headers['content-encoding'];
  delete headers['transfer-encoding'];
  headers['content-length'] = String(bodyBuf.length);

  return {
    status:     parsed.status,
    statusText: parsed.statusText,
    headers,
    bodyBuf,
    body,
    latency_ms: Date.now() - t0,
  };
}

// ── Raw socket HTTP/HTTPS forward ────────────────────────────
// Bypasses Node's http/https.request() parser so servers that send
// both Content-Length and Transfer-Encoding don't crash us.
function forwardRaw(reqObj) {
  return new Promise(resolve => {
    let parsed;
    try { parsed = new URL(reqObj.url); } catch (_) {
      return resolve({
        status:502, statusText:'Bad Gateway', headers:{},
        bodyBuf:Buffer.alloc(0), body:'Invalid URL', latency_ms:0,
      });
    }

    const isHTTPS = parsed.protocol === 'https:';
    const host    = parsed.hostname;
    const port    = parsed.port ? parseInt(parsed.port, 10) : (isHTTPS ? 443 : 80);
    const path    = (parsed.pathname || '/') + (parsed.search || '');
    const t0      = Date.now();

    // Build request — strip proxy-only headers
    const fwdHeaders = { ...reqObj.headers };
    delete fwdHeaders['proxy-connection'];
    delete fwdHeaders['proxy-authorization'];
    delete fwdHeaders['te'];
    delete fwdHeaders['trailers'];
    fwdHeaders['host']       = host;
    fwdHeaders['connection'] = 'close';
    // FIX-R5: Tell origin we can handle any encoding — we decompress ourselves
    fwdHeaders['accept-encoding'] = 'gzip, deflate, br';

    const hlines      = Object.entries(fwdHeaders).map(([k, v]) => `${k}: ${v}`).join('\r\n');
    const requestLine = `${reqObj.method} ${path} HTTP/1.1`;
    const headerBlock = Buffer.from(`${requestLine}\r\n${hlines}\r\n\r\n`, 'utf8');
    const bodyBuf     = reqObj.bodyBuf instanceof Buffer
      ? reqObj.bodyBuf
      : Buffer.from(reqObj.body || '', 'utf8');
    const rawReqBuf   = Buffer.concat([headerBlock, bodyBuf]);

    const resBufs = [];
    let settled   = false;

    // FIX-R4: Single async settlement function used by both 'end' and 'close'
    async function settle(rawBuf, errorResult) {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (_) {}

      if (errorResult) {
        resolve({ ...errorResult, latency_ms: Date.now() - t0 });
        return;
      }
      // Always run through processRawResponse — handles decompression
      const result = await processRawResponse(rawBuf, t0);
      resolve(result);
    }

    const sock = isHTTPS
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] })
      : net.connect({ host, port });

    sock.setMaxListeners(20);
    sock.setTimeout(30000);

    sock.once('timeout', () => settle(null, {
      status:504, statusText:'Gateway Timeout', headers:{},
      bodyBuf:Buffer.alloc(0), body:'Upstream timeout',
    }));

    sock.once('error', e => settle(null, {
      status:502, statusText:'Bad Gateway', headers:{},
      bodyBuf:Buffer.alloc(0), body: e.message,
    }));

    const onConnect = () => { try { sock.write(rawReqBuf); } catch (_) {} };
    if (isHTTPS) sock.once('secureConnect', onConnect);
    else         sock.once('connect',       onConnect);

    sock.on('data', chunk => resBufs.push(chunk));

    // FIX-R4: Both 'end' and 'close' call the same settle() path.
    // 'end' = server sent FIN (clean close). 'close' = connection dropped
    // (common with many real servers). Both settle with the full buffer.
    sock.once('end', () => {
      settle(Buffer.concat(resBufs));
    });

    sock.once('close', () => {
      if (!settled) {
        const raw = Buffer.concat(resBufs);
        if (raw.length) {
          settle(raw);
        } else {
          settle(null, {
            status:502, statusText:'Bad Gateway', headers:{},
            bodyBuf:Buffer.alloc(0), body:'Connection closed with no data',
          });
        }
      }
    });
  });
}

// ── Write a resolved response to the client ──────────────────
function sendResponse(clientRes, resObj) {
  try {
    const headers = { ...resObj.headers };
    delete headers['transfer-encoding'];
    const body = resObj.bodyBuf instanceof Buffer ? resObj.bodyBuf : Buffer.from(resObj.body || '');
    headers['content-length'] = String(body.length);
    clientRes.writeHead(resObj.status || 502, headers);
    clientRes.end(body);
  } catch (_) {}
}

// ── REST API ──────────────────────────────────────────────────
async function handleAPI(pathname, method, bodyStr, res) {
  let body = {};
  try { body = JSON.parse(bodyStr || '{}'); } catch (_) {}

  // ── Requests ──
  if (method === 'GET'  && pathname === '/api/requests') return sendJSON(res, db.list(1000));
  if (method === 'GET'  && /^\/api\/requests\/\d+$/.test(pathname)) {
    const id = parseInt(pathname.split('/')[3], 10);
    const r  = db.getById(id);
    if (!r) return sendJSON(res, { error:'not found' }, 404);
    return sendJSON(res, { ...r, scanner_hits: db.hitsFor(id) });
  }
  if (method === 'POST' && pathname === '/api/requests/clear') { db.clearAll(); return sendJSON(res, { ok:true }); }
  if (method === 'POST' && pathname === '/api/search')          return sendJSON(res, db.search(body.q || ''));

  // ── Repeater ──
  if (method === 'POST' && pathname === '/api/repeat') {
    const { method:m, url:u, headers:h = {}, body:b } = body;
    if (!u) return sendJSON(res, { error:'url required' }, 400);
    let pUrl;
    try { pUrl = new URL(u); } catch (_) {
      try { pUrl = new URL('https://' + u); } catch (_2) {
        return sendJSON(res, { error:'invalid url' }, 400);
      }
    }
    const reqObj = {
      method:  m || 'GET',
      url:     pUrl.href,
      headers: h,
      body:    b || '',
      bodyBuf: Buffer.from(b || '', 'utf8'),
    };
    const result = await forwardRaw(reqObj);
    return sendJSON(res, {
      status:  result.status,
      headers: result.headers,
      body:    result.body,
      latency: result.latency_ms,
    });
  }

  // ── Intercept ──
  if (method === 'GET'  && pathname === '/api/intercept/status')
    return sendJSON(res, { enabled: intercept.enabled, pending: intercept.listPending() });
  if (method === 'POST' && pathname === '/api/intercept/toggle') {
    intercept.setEnabled(!intercept.enabled);
    bridge.emitStatus({ intercept: intercept.enabled });
    return sendJSON(res, { enabled: intercept.enabled });
  }
  if (method === 'POST' && pathname === '/api/intercept/forward')
    return sendJSON(res, { ok: intercept.forward(body.id, body.request) });
  if (method === 'POST' && pathname === '/api/intercept/drop')
    return sendJSON(res, { ok: intercept.drop(body.id) });
  if (method === 'POST' && pathname === '/api/intercept/forward-all') {
    intercept.forwardAll(); return sendJSON(res, { ok:true });
  }

  // ── Intercept rules ──
  if (method === 'GET'    && pathname === '/api/rules')                   return sendJSON(res, db.listRules());
  if (method === 'POST'   && pathname === '/api/rules')                   { db.addRule(body); return sendJSON(res, { ok:true }); }
  if (method === 'DELETE' && /^\/api\/rules\/\d+$/.test(pathname))       { db.deleteRule(parseInt(pathname.split('/')[3], 10)); return sendJSON(res, { ok:true }); }

  // ── Match-replace rules ──
  if (method === 'GET'    && pathname === '/api/mr-rules')                return sendJSON(res, db.listMR());
  if (method === 'POST'   && pathname === '/api/mr-rules')                { db.addMR(body); return sendJSON(res, { ok:true }); }
  if (method === 'DELETE' && /^\/api\/mr-rules\/\d+$/.test(pathname))    { db.deleteMR(parseInt(pathname.split('/')[3], 10)); return sendJSON(res, { ok:true }); }

  // ── Saved requests ──
  if (method === 'GET'    && pathname === '/api/saved')                   return sendJSON(res, db.listSaved());
  if (method === 'POST'   && pathname === '/api/saved')                   { db.saveRequest(body); return sendJSON(res, { ok:true }); }
  if (method === 'DELETE' && /^\/api\/saved\/\d+$/.test(pathname))       { db.deleteSaved(parseInt(pathname.split('/')[3], 10)); return sendJSON(res, { ok:true }); }

  // ── Stats ──
  if (method === 'GET' && pathname === '/api/stats')
    return sendJSON(res, { ...stats, uptime: Date.now() - stats.startedAt });

  // ── CA cert download ──
  if (method === 'GET' && pathname === '/api/ca.crt') {
    try {
      const buf = fs.readFileSync(ca.caCertDerPath);
      res.writeHead(200, {
        'Content-Type':        'application/x-x509-ca-cert',
        'Content-Disposition': 'attachment; filename="secproxy-ca.crt"',
        'Content-Length':      buf.length,
      });
      return res.end(buf);
    } catch (_) { return sendJSON(res, { error:'CA cert not found' }, 404); }
  }

  // ── Proxy info ──
  if (method === 'GET' && pathname === '/api/info')
    return sendJSON(res, { proxyHost: getLanIP(), proxyPort: PROXY_PORT, wsPort: WS_PORT });

  sendJSON(res, { error:'not found' }, 404);
}

// ── Main server ───────────────────────────────────────────────
const server = http.createServer(async (clientReq, clientRes) => {
  const reqUrl = clientReq.url || '/';

  // Only intercept OPTIONS for /api/* — forward all other OPTIONS normally
  if (clientReq.method === 'OPTIONS' && reqUrl.startsWith('/api/')) {
    clientRes.writeHead(204, corsHeaders()); clientRes.end(); return;
  }

  // API requests from the Proxy UI
  if (reqUrl.startsWith('/api/')) {
    const bodyStr = (await collectBody(clientReq)).toString('utf8');
    return handleAPI(reqUrl.split('?')[0], clientReq.method, bodyStr, clientRes);
  }

  // ── Proxy request ─────────────────────────────────────────
  stats.total++;

  const fullReqUrl = reqUrl.startsWith('http')
    ? reqUrl
    : `http://${clientReq.headers['host'] || 'localhost'}${reqUrl}`;

  let parsed;
  try { parsed = new URL(fullReqUrl); }
  catch (_) {
    try { parsed = new URL('http://localhost' + reqUrl); }
    catch (_2) {
      try { clientRes.writeHead(400); clientRes.end('Bad Request'); } catch (_3) {}
      return;
    }
  }

  const scheme = parsed.protocol === 'https:' ? 'https' : 'http';
  const host   = parsed.hostname || (clientReq.headers['host'] || '').split(':')[0];
  const port   = parsed.port ? parseInt(parsed.port, 10) : (scheme === 'https' ? 443 : 80);

  const bodyBuf = await collectBody(clientReq);
  const bodyStr = bodyBuf.length ? bodyBuf.toString('utf8') : '';
  const headers = {};
  for (const [k, v] of Object.entries(clientReq.headers)) headers[k] = v;

  let reqObj = {
    method: clientReq.method, scheme, host, port,
    path:   (parsed.pathname || '/') + (parsed.search || ''),
    url:    fullReqUrl,
    headers, body: bodyStr, bodyBuf,
  };

  // Match-replace on request
  reqObj = intercept.applyMR(reqObj, 'request');

  // Intercept pause
  let finalReq = reqObj;
  try {
    const r = await intercept.pause(reqObj);
    if (r.action === 'drop') {
      stats.intercepted++;
      try { clientRes.writeHead(502); clientRes.end('Request dropped by Séç Proxy.'); } catch (_) {}
      return;
    }
    finalReq = r.request;
    if (intercept.enabled) stats.intercepted++;
  } catch (_) {}

  // Ensure bodyBuf is present even after intercept modification
  if (!(finalReq.bodyBuf instanceof Buffer)) {
    finalReq.bodyBuf = Buffer.from(finalReq.body || '', 'utf8');
  }

  // Store request
  const reqId = db.insertRequest(finalReq);
  bridge.emitRequest({ id:reqId, ...finalReq, req_headers:finalReq.headers, req_body:finalReq.body });

  // Forward using raw socket — safe against dual Content-Length + TE headers
  const resObj = await forwardRaw(finalReq);

  if (resObj.status >= 500) stats.errors++;

  // Apply match-replace on response BEFORE sending to client
  const modRes   = intercept.applyMR(resObj, 'response');
  const modBuf   = modRes.bodyBuf instanceof Buffer && modRes.body === resObj.body
    ? modRes.bodyBuf
    : Buffer.from(modRes.body || '');
  modRes.bodyBuf = modBuf;
  modRes.headers = { ...modRes.headers, 'content-length': String(modBuf.length) };
  delete modRes.headers['transfer-encoding'];
  delete modRes.headers['content-encoding'];

  sendResponse(clientRes, modRes);

  db.updateResponse(reqId, {
    status:     modRes.status,
    headers:    modRes.headers,
    body:       modRes.body,
    latency_ms: modRes.latency_ms,
  });

  stats.bytesOut += bodyBuf.length;
  stats.bytesIn  += modBuf.length;

  try {
    const full = db.getById(reqId);
    const hits = scanner.scan(full);
    if (hits.length) {
      hits.forEach(h => db.addHit({ request_id:reqId, ...h }));
      bridge.emitScannerHit(reqId, hits);
    }
  } catch (_) {}

  bridge.emitResponse({
    id:          reqId,
    res_status:  modRes.status,
    res_headers: modRes.headers,
    res_body:    modRes.body,
    latency_ms:  modRes.latency_ms,
  });
  bridge.emitStats(stats);
});

// ── HTTPS CONNECT → MITM ─────────────────────────────────────
server.on('connect', (req, socket, head) => {
  stats.total++;
  const [hostname, portStr = '443'] = (req.url || '').split(':');
  mitm.handleConnect(socket, hostname, parseInt(portStr, 10));
});

// Set error handler once per connection — prevents MaxListeners warning
server.on('connection', socket => {
  socket.setMaxListeners(20);
  socket.on('error', () => {});
});

server.on('clientError', (err, socket) => {
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (_) {}
});

// ── Wire intercept events → WS ───────────────────────────────
intercept.on('paused',    ({ id, request }) => { stats.intercepted++; bridge.emitIntercepted(id, request); });
intercept.on('forwarded', ({ id })          => bridge.emitInterceptDone(id, 'forward'));
intercept.on('dropped',   ({ id })          => bridge.emitInterceptDone(id, 'drop'));

// ── Start ─────────────────────────────────────────────────────
db.init().then(() => ca.caInitPromise).then(() => {
  const BIND_IP = netsetup.setup();
  server.listen(PROXY_PORT, BIND_IP, () => {
    bridge.start(WS_PORT);
    const lanIP = getLanIP();
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║          Séç Proxy v2.0 — RUNNING           ║');
    console.log('╠══════════════════════════════════════════════╣');
    console.log(`║  Proxy   →  ${BIND_IP}:${PROXY_PORT}`);
    console.log(`║  Alias   →  ${netsetup.aliasIP}:${PROXY_PORT} (set in Drony)`);
    console.log(`║  WS      →  ws://0.0.0.0:${WS_PORT}`);
    console.log(`║  API     →  http://127.0.0.1:${PROXY_PORT}/api`);
    console.log('╠══════════════════════════════════════════════╣');
    console.log('║  Browser proxy: 127.0.0.1:8080              ║');
    console.log('║  CA cert:       GET /api/ca.crt              ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');
  });
}).catch(e => {
  console.error('[Proxy] DB init failed:', e.message);
  process.exit(1);
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE')
    console.error(`[Proxy] Port ${PROXY_PORT} in use. Try: PROXY_PORT=8082 node server/proxy.js`);
  else
    console.error('[Proxy]', e.message);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('
[Proxy] Shutting down.');
  netsetup.teardown();
  db.close();
  process.exit(0);
});
