/* ============================================================
   server/mitm.js — HTTPS MITM engine
   Séç Proxy v2.0

   
   ============================================================ */
'use strict';

const tls       = require('tls');
const net       = require('net');
const ca        = require('./ca');
const db        = require('./db');
const bridge    = require('./ws-bridge');
const intercept = require('./intercept');
const scanner   = require('./scanner');

const SOCKET_TIMEOUT = 30000; // 30s

// HTTP status reason phrases (common subset)
const STATUS_PHRASES = {
  100:'Continue', 101:'Switching Protocols',
  200:'OK', 201:'Created', 202:'Accepted', 204:'No Content',
  206:'Partial Content',
  301:'Moved Permanently', 302:'Found', 303:'See Other',
  304:'Not Modified', 307:'Temporary Redirect', 308:'Permanent Redirect',
  400:'Bad Request', 401:'Unauthorized', 403:'Forbidden', 404:'Not Found',
  405:'Method Not Allowed', 408:'Request Timeout', 409:'Conflict',
  410:'Gone', 413:'Payload Too Large', 422:'Unprocessable Entity',
  429:'Too Many Requests',
  500:'Internal Server Error', 502:'Bad Gateway', 503:'Service Unavailable',
  504:'Gateway Timeout',
};
function reasonPhrase(status) {
  return STATUS_PHRASES[status] || 'Unknown';
}

// ── Parse raw HTTP request buffer ───────────────────────────
function parseReqBuf(buf, scheme, host, port) {
  const raw     = buf.toString('binary');
  const sep     = raw.indexOf('\r\n\r\n');
  const headRaw = sep >= 0 ? raw.slice(0, sep) : raw;
  const lines   = headRaw.split('\r\n');
  const parts   = (lines[0] || '').split(' ');
  const method  = parts[0] || 'GET';
  const rawPath = parts[1] || '/';
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].indexOf(':');
    if (c < 0) continue;
    headers[lines[i].slice(0, c).trim().toLowerCase()] = lines[i].slice(c + 1).trim();
  }
  const bodyBuf = sep >= 0 ? buf.slice(sep + 4) : Buffer.alloc(0);
  return {
    method, path: rawPath, headers,
    bodyBuf,
    body: bodyBuf.toString('utf8'),
    scheme, host, port,
    url: `${scheme}://${host}${rawPath}`,
  };
}

// ── Parse raw HTTP response buffer ──────────────────────────
// FIX-R1: We parse the raw bytes from the origin ourselves so we
// never feed a Content-Length + Transfer-Encoding response into
// Node's http parser (which rejects it). We handle the conflict here.
function parseResBuf(buf) {
  const raw = buf.toString('binary');
  const sep = raw.indexOf('\r\n\r\n');
  if (sep < 0) {
    return { status: 0, statusText: 'Unknown', headers: {}, body: buf.toString('utf8'), bodyBuf: buf };
  }
  const head  = raw.slice(0, sep);
  const lines = head.split('\r\n');
  const m     = (lines[0] || '').match(/HTTP\/[\d.]+ (\d+)(?:\s+(.*))?/);
  const status     = m ? parseInt(m[1], 10) : 0;
  const statusText = (m && m[2]) ? m[2].trim() : reasonPhrase(status);
  const headers    = {};
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].indexOf(':');
    if (c < 0) continue;
    const key = lines[i].slice(0, c).trim().toLowerCase();
    const val = lines[i].slice(c + 1).trim();
    // Collect duplicate headers (e.g. set-cookie) as arrays
    if (headers[key] !== undefined) {
      if (Array.isArray(headers[key])) headers[key].push(val);
      else headers[key] = [headers[key], val];
    } else {
      headers[key] = val;
    }
  }

  const isChunked = (headers['transfer-encoding'] || '').toLowerCase().includes('chunked');
  let bodyBuf;
  if (isChunked) {
    bodyBuf = decodeChunked(buf.slice(sep + 4));
  } else {
    bodyBuf = buf.slice(sep + 4);
  }

  let body = '';
  try { body = bodyBuf.toString('utf8'); } catch (_) {}

  return { status, statusText, headers, body, bodyBuf };
}

// ── Decode chunked transfer-encoded body into a plain Buffer ─
function decodeChunked(buf) {
  const parts = [];
  let pos = 0;
  const raw = buf.toString('binary');
  while (pos < raw.length) {
    const nl = raw.indexOf('\r\n', pos);
    if (nl < 0) break;
    const sizeLine = raw.slice(pos, nl).split(';')[0].trim(); // ignore chunk extensions
    const size = parseInt(sizeLine, 16);
    if (isNaN(size) || size === 0) break;
    const start = nl + 2;
    const end   = start + size;
    parts.push(buf.slice(start, end));
    pos = end + 2; // skip trailing \r\n after chunk data
  }
  return parts.length ? Buffer.concat(parts) : buf; // fallback: return as-is
}

// ── Check if we have a complete HTTP request ─────────────────
function isComplete(buf) {
  const raw = buf.toString('binary');
  const sep = raw.indexOf('\r\n\r\n');
  if (sep < 0) return false;

  const head    = raw.slice(0, sep);
  const bodyRaw = raw.slice(sep + 4);

  const clMatch = head.match(/content-length:\s*(\d+)/i);
  if (clMatch) {
    return bodyRaw.length >= parseInt(clMatch[1], 10);
  }
  if (/transfer-encoding:\s*chunked/i.test(head)) {
    return bodyRaw.includes('0\r\n\r\n');
  }
  return true;
}

// ── Forward request over a raw TLS socket ───────────────────
// FIX-R1: We use a raw tls.connect() and accumulate raw bytes rather
// than http.request(), so the response is never fed into Node's strict
// HTTP parser. This handles the Content-Length + Transfer-Encoding
// conflict that many real-world servers emit.
function forwardRaw(finalReq, hostname, port) {
  return new Promise((resolve) => {
    const t0 = Date.now();

    // Build request buffer
    // Strip hop-by-hop headers that must not be forwarded
    const fwdHeaders = { ...finalReq.headers };
    delete fwdHeaders['proxy-connection'];
    delete fwdHeaders['proxy-authorization'];
    delete fwdHeaders['te'];
    delete fwdHeaders['trailers'];
    delete fwdHeaders['upgrade'];
    // Ensure host is set
    fwdHeaders['host'] = fwdHeaders['host'] || hostname;
    // Ensure connection: close so the server doesn't keep the socket open
    fwdHeaders['connection'] = 'close';

    const hlines      = Object.entries(fwdHeaders).map(([k, v]) => `${k}: ${v}`).join('\r\n');
    const requestLine = `${finalReq.method} ${finalReq.path} HTTP/1.1`;
    const headerBlock = Buffer.from(`${requestLine}\r\n${hlines}\r\n\r\n`, 'utf8');
    const bodyBuf     = finalReq.bodyBuf instanceof Buffer
      ? finalReq.bodyBuf
      : Buffer.from(finalReq.body || '', 'utf8');
    const rawReqBuf   = Buffer.concat([headerBlock, bodyBuf]);

    // FIX-R2: Create a fresh socket per request. This avoids the
    // MaxListeners warning from accumulating listeners on a reused socket.
    const origin = tls.connect({
      host:               hostname,
      port,
      servername:         hostname,
      rejectUnauthorized: false,
    });

    // FIX-R2: Set a generous but finite max listeners count
    origin.setMaxListeners(20);
    origin.setTimeout(SOCKET_TIMEOUT);

    const resBufs = [];
    let settled   = false;

    function settle(result) {
      if (settled) return;
      settled = true;
      origin.destroy();
      resolve({ ...result, latency_ms: Date.now() - t0 });
    }

    origin.once('timeout', () => {
      settle({ status: 504, statusText: 'Gateway Timeout', headers: {}, body: 'MITM: origin timeout', bodyBuf: Buffer.alloc(0) });
    });

    origin.once('error', (e) => {
      settle({ status: 502, statusText: 'Bad Gateway', headers: {}, body: `MITM: ${e.message}`, bodyBuf: Buffer.alloc(0) });
    });

    origin.once('secureConnect', () => {
      try { origin.write(rawReqBuf); } catch (_) {}
    });

    origin.on('data', (chunk) => {
      resBufs.push(chunk);
    });

    origin.once('end', () => {
      const rawResBuf = Buffer.concat(resBufs);
      let resObj = { status: 0, statusText: 'Unknown', headers: {}, body: '', bodyBuf: Buffer.alloc(0) };
      try { resObj = parseResBuf(rawResBuf); } catch (_) {}
      settle(resObj);
    });

    origin.once('close', () => {
      if (!settled && resBufs.length) {
        const rawResBuf = Buffer.concat(resBufs);
        let resObj = { status: 0, statusText: 'Unknown', headers: {}, body: '', bodyBuf: Buffer.alloc(0) };
        try { resObj = parseResBuf(rawResBuf); } catch (_) {}
        settle(resObj);
      } else if (!settled) {
        settle({ status: 502, statusText: 'Bad Gateway', headers: {}, body: 'MITM: connection closed', bodyBuf: Buffer.alloc(0) });
      }
    });
  });
}

// ── Main CONNECT handler ─────────────────────────────────────
function handleConnect(clientSocket, hostname, port) {
  try {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  } catch (e) {
    clientSocket.destroy();
    return;
  }

  ca.getCertForHost(hostname).then(mitmCreds => {
    _startTLS(clientSocket, hostname, port, mitmCreds);
  }).catch(e => {
    console.error(`[MITM] Cert fail for ${hostname}: ${e.message}`);
    transparentTunnel(clientSocket, hostname, port);
  });
}

// ── Start TLS wrapping after cert is ready ───────────────────
function _startTLS(clientSocket, hostname, port, mitmCreds) {
  let tlsClient;
  try {
    tlsClient = new tls.TLSSocket(clientSocket, {
      isServer:    true,
      key:         mitmCreds.key,
      cert:        mitmCreds.cert,
      requestCert: false,
    });
  } catch (e) {
    console.error(`[MITM] TLS wrap fail for ${hostname}: ${e.message}`);
    clientSocket.destroy();
    return;
  }

  // FIX-R2: Set high max listeners on the client socket to prevent
  // MaxListenersExceededWarning on keep-alive connections.
  tlsClient.setMaxListeners(50);
  tlsClient.setTimeout(SOCKET_TIMEOUT);
  tlsClient.once('timeout', () => tlsClient.destroy());
  tlsClient.on('error', () => { try { tlsClient.destroy(); } catch (_) {} });

  let reqBuf = Buffer.alloc(0);

  tlsClient.on('data', (chunk) => {
    reqBuf = Buffer.concat([reqBuf, chunk]);
    if (!isComplete(reqBuf)) return;

    const snapshot = reqBuf;
    reqBuf = Buffer.alloc(0);
    processRequest(snapshot, hostname, port, tlsClient);
  });

  tlsClient.on('end',   () => {});
  tlsClient.on('close', () => {});
}

// ── Process one decrypted HTTP request ──────────────────────
function processRequest(reqBuf, hostname, port, tlsClient) {
  let reqObj;
  try {
    reqObj = parseReqBuf(reqBuf, 'https', hostname, port);
  } catch (e) {
    console.error(`[MITM] Parse error ${hostname}: ${e.message}`);
    return;
  }

  const modReq = intercept.applyMR(reqObj, 'request');

  intercept.pause(modReq).then(async ({ action, request: finalReq }) => {
    if (action === 'drop') {
      try { tlsClient.end(); } catch (_) {}
      return;
    }

    let reqId;
    try {
      reqId = db.insertRequest(finalReq);
    } catch (e) {
      console.error(`[MITM] DB insert error: ${e.message}`);
    }

    if (reqId != null) {
      bridge.emitRequest({ id: reqId, ...finalReq, req_headers: finalReq.headers, req_body: finalReq.body });
    }

    // FIX-R1: Use raw socket forward — bypasses Node's http parser
    // so Content-Length + Transfer-Encoding conflicts don't throw.
    const resObj = await forwardRaw(finalReq, hostname, port);

    // Apply match-replace on response BEFORE sending to browser (Bug 11)
    const modRes    = intercept.applyMR(resObj, 'response');
    const modBodyBuf = modRes.bodyBuf instanceof Buffer && modRes.body === resObj.body
      ? modRes.bodyBuf
      : Buffer.from(modRes.body || '', 'utf8');

    // FIX-R1: Strip conflicting headers; set definitive content-length.
    const respHeaders = { ...modRes.headers };
    delete respHeaders['transfer-encoding'];  // we already decoded chunks
    delete respHeaders['content-encoding'];   // body is already decompressed by origin if any
    respHeaders['content-length'] = String(modBodyBuf.length);

    // FIX-R3: Use correct status code and real reason phrase (was hardcoded 'OK')
    const finalStatus = modRes.status || resObj.status || 502;
    const statusLine  = `HTTP/1.1 ${finalStatus} ${modRes.statusText || reasonPhrase(finalStatus)}`;

    // Serialize headers — expand arrays (e.g. multiple set-cookie)
    const headerLines = [];
    for (const [k, v] of Object.entries(respHeaders)) {
      if (Array.isArray(v)) v.forEach(vv => headerLines.push(`${k}: ${vv}`));
      else headerLines.push(`${k}: ${v}`);
    }

    const headerBlock = Buffer.from(`${statusLine}\r\n${headerLines.join('\r\n')}\r\n\r\n`, 'utf8');
    const fullResBuf  = Buffer.concat([headerBlock, modBodyBuf]);

    try { tlsClient.write(fullResBuf); } catch (_) {}

    if (reqId != null) {
      try {
        db.updateResponse(reqId, {
          status:     finalStatus,
          headers:    modRes.headers,
          body:       modRes.body,
          latency_ms: resObj.latency_ms,
        });
      } catch (e) {
        console.error(`[MITM] DB update error: ${e.message}`);
      }

      try {
        const full = db.getById(reqId);
        const hits = scanner.scan(full);
        if (hits.length) {
          hits.forEach(h => db.addHit({ request_id: reqId, ...h }));
          bridge.emitScannerHit(reqId, hits);
        }
      } catch (_) {}

      bridge.emitResponse({
        id:          reqId,
        res_status:  finalStatus,
        res_headers: modRes.headers,
        res_body:    modRes.body,
        latency_ms:  resObj.latency_ms,
      });
    }

    // Keep-alive: don't close — wait for next request on same TLS socket.
    // Only close if the server or client signals connection: close.
    const connHeader = (modRes.headers['connection'] || '').toLowerCase();
    if (connHeader === 'close') {
      try { tlsClient.end(); } catch (_) {}
    }

  }).catch((e) => {
    console.error(`[MITM] Intercept error: ${e.message}`);
    try { tlsClient.destroy(); } catch (_) {}
  });
}

// ── Transparent TCP tunnel fallback ─────────────────────────
function transparentTunnel(clientSocket, hostname, port) {
  const tunnel = net.connect(port, hostname, () => {
    clientSocket.pipe(tunnel);
    tunnel.pipe(clientSocket);
  });
  tunnel.setMaxListeners(20);
  tunnel.on('error',        () => { try { clientSocket.destroy(); } catch (_) {} });
  clientSocket.on('error',  () => { try { tunnel.destroy();       } catch (_) {} });
}

module.exports = { handleConnect };
