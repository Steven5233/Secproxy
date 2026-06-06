/* ============================================================
   server/mitm.js — HTTPS MITM engine
   Séç Proxy v2.0

   All previous fixes retained + new:
   FIX-R4: Garbled binary response — compressed bodies were not
            being decompressed. forwardRaw() settle() was synchronous
            and skipped decompression entirely. Replaced with an async
            processRawResponse() path (same as proxy.js) that always
            decompresses gzip/deflate/br before resolving.
   ============================================================ */
'use strict';

const tls       = require('tls');
const net       = require('net');
const zlib      = require('zlib');
const ca        = require('./ca');
const db        = require('./db');
const bridge    = require('./ws-bridge');
const intercept = require('./intercept');
const scanner   = require('./scanner');

const SOCKET_TIMEOUT = 30000;

// HTTP status reason phrases
const STATUS_PHRASES = {
  200:'OK', 201:'Created', 204:'No Content', 206:'Partial Content',
  301:'Moved Permanently', 302:'Found', 303:'See Other', 304:'Not Modified',
  307:'Temporary Redirect', 308:'Permanent Redirect',
  400:'Bad Request', 401:'Unauthorized', 403:'Forbidden', 404:'Not Found',
  405:'Method Not Allowed', 429:'Too Many Requests',
  500:'Internal Server Error', 502:'Bad Gateway', 503:'Service Unavailable', 504:'Gateway Timeout',
};
function reasonPhrase(s) { return STATUS_PHRASES[s] || 'Unknown'; }

// ── Decompress ───────────────────────────────────────────────
function decompress(buf, enc) {
  return new Promise(resolve => {
    if (!enc || !buf.length) return resolve(buf);
    const e   = enc.toLowerCase();
    const cb  = (err, result) => resolve(err ? buf : result);
    if      (e.includes('br'))      zlib.brotliDecompress(buf, cb);
    else if (e.includes('gzip'))    zlib.gunzip(buf, cb);
    else if (e.includes('deflate')) zlib.inflate(buf, cb);
    else resolve(buf);
  });
}

// ── Decode chunked body ──────────────────────────────────────
function decodeChunked(buf) {
  const parts = [];
  let pos = 0;
  const raw = buf.toString('binary');
  while (pos < raw.length) {
    const nl   = raw.indexOf('\r\n', pos);
    if (nl < 0) break;
    const size = parseInt(raw.slice(pos, nl).split(';')[0].trim(), 16);
    if (isNaN(size) || size === 0) break;
    const start = nl + 2;
    parts.push(buf.slice(start, start + size));
    pos = start + size + 2;
  }
  return parts.length ? Buffer.concat(parts) : buf;
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
    method, path: rawPath, headers, bodyBuf,
    body: bodyBuf.toString('utf8'),
    scheme, host, port,
    url: `${scheme}://${host}${rawPath}`,
  };
}

// ── Parse raw HTTP response buffer ──────────────────────────
function parseResBuf(buf) {
  const raw = buf.toString('binary');
  const sep = raw.indexOf('\r\n\r\n');
  if (sep < 0) {
    return { status:0, statusText:'Unknown', headers:{}, bodyBuf:buf, encoding:'' };
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
    if (headers[key] !== undefined) {
      headers[key] = Array.isArray(headers[key]) ? [...headers[key], val] : [headers[key], val];
    } else {
      headers[key] = val;
    }
  }
  const isChunked = (headers['transfer-encoding'] || '').toLowerCase().includes('chunked');
  let bodyBuf = buf.slice(sep + 4);
  if (isChunked) bodyBuf = decodeChunked(bodyBuf);
  const encoding = headers['content-encoding'] || '';
  return { status, statusText, headers, bodyBuf, encoding };
}

// ── FIX-R4: Unified async response processor ─────────────────
// Always decompresses. Called from both 'end' and 'close' paths.
async function processRawResponse(rawBuf, t0) {
  let parsed;
  try {
    parsed = parseResBuf(rawBuf);
  } catch (_) {
    return {
      status:502, statusText:'Bad Gateway', headers:{},
      bodyBuf:Buffer.alloc(0), body:'', latency_ms: Date.now() - t0,
    };
  }

  let bodyBuf = parsed.bodyBuf;
  if (parsed.encoding) {
    try { bodyBuf = await decompress(parsed.bodyBuf, parsed.encoding); } catch (_) {}
  }

  const headers = { ...parsed.headers };
  delete headers['content-encoding'];
  delete headers['transfer-encoding'];
  headers['content-length'] = String(bodyBuf.length);

  return {
    status:     parsed.status,
    statusText: parsed.statusText,
    headers,
    bodyBuf,
    body:       bodyBuf.toString('utf8'),
    latency_ms: Date.now() - t0,
  };
}

// ── Check if a full HTTP request has been received ───────────
function isComplete(buf) {
  const raw = buf.toString('binary');
  const sep = raw.indexOf('\r\n\r\n');
  if (sep < 0) return false;
  const head    = raw.slice(0, sep);
  const bodyRaw = raw.slice(sep + 4);
  const clMatch = head.match(/content-length:\s*(\d+)/i);
  if (clMatch) return bodyRaw.length >= parseInt(clMatch[1], 10);
  if (/transfer-encoding:\s*chunked/i.test(head)) return bodyRaw.includes('0\r\n\r\n');
  return true;
}

// ── Forward request to origin over raw TLS socket ───────────
// FIX-R4: settle() is now async and always runs processRawResponse()
// which decompresses regardless of whether 'end' or 'close' fired.
function forwardRaw(finalReq, hostname, port) {
  return new Promise(resolve => {
    const t0 = Date.now();

    const fwdHeaders = { ...finalReq.headers };
    delete fwdHeaders['proxy-connection'];
    delete fwdHeaders['proxy-authorization'];
    delete fwdHeaders['te'];
    delete fwdHeaders['trailers'];
    delete fwdHeaders['upgrade'];
    fwdHeaders['host']            = fwdHeaders['host'] || hostname;
    fwdHeaders['connection']      = 'close';
    fwdHeaders['accept-encoding'] = 'gzip, deflate, br';

    const hlines      = Object.entries(fwdHeaders).map(([k, v]) => `${k}: ${v}`).join('\r\n');
    const requestLine = `${finalReq.method} ${finalReq.path} HTTP/1.1`;
    const headerBlock = Buffer.from(`${requestLine}\r\n${hlines}\r\n\r\n`, 'utf8');
    const bodyBuf     = finalReq.bodyBuf instanceof Buffer
      ? finalReq.bodyBuf
      : Buffer.from(finalReq.body || '', 'utf8');
    const rawReqBuf   = Buffer.concat([headerBlock, bodyBuf]);

    const resBufs = [];
    let settled   = false;

    async function settle(rawBuf, errorResult) {
      if (settled) return;
      settled = true;
      try { origin.destroy(); } catch (_) {}
      if (errorResult) {
        resolve({ ...errorResult, latency_ms: Date.now() - t0 });
        return;
      }
      resolve(await processRawResponse(rawBuf, t0));
    }

    const origin = tls.connect({
      host: hostname, port, servername: hostname, rejectUnauthorized: false,
    });
    origin.setMaxListeners(20);
    origin.setTimeout(SOCKET_TIMEOUT);

    origin.once('timeout', () => settle(null, {
      status:504, statusText:'Gateway Timeout', headers:{}, bodyBuf:Buffer.alloc(0), body:'MITM: timeout',
    }));
    origin.once('error', e => settle(null, {
      status:502, statusText:'Bad Gateway', headers:{}, bodyBuf:Buffer.alloc(0), body:`MITM: ${e.message}`,
    }));
    origin.once('secureConnect', () => { try { origin.write(rawReqBuf); } catch (_) {} });
    origin.on('data', chunk => resBufs.push(chunk));
    origin.once('end',   () => settle(Buffer.concat(resBufs)));
    origin.once('close', () => {
      if (!settled) {
        const raw = Buffer.concat(resBufs);
        raw.length
          ? settle(raw)
          : settle(null, { status:502, statusText:'Bad Gateway', headers:{}, bodyBuf:Buffer.alloc(0), body:'MITM: connection closed' });
      }
    });
  });
}

// ── Main CONNECT handler ─────────────────────────────────────
function handleConnect(clientSocket, hostname, port) {
  try {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  } catch (e) {
    clientSocket.destroy(); return;
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
      isServer: true, key: mitmCreds.key, cert: mitmCreds.cert, requestCert: false,
    });
  } catch (e) {
    console.error(`[MITM] TLS wrap fail for ${hostname}: ${e.message}`);
    clientSocket.destroy(); return;
  }

  tlsClient.setMaxListeners(50);
  tlsClient.setTimeout(SOCKET_TIMEOUT);
  tlsClient.once('timeout', () => tlsClient.destroy());
  tlsClient.on('error', () => { try { tlsClient.destroy(); } catch (_) {} });

  let reqBuf = Buffer.alloc(0);
  tlsClient.on('data', chunk => {
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
    console.error(`[MITM] Parse error ${hostname}: ${e.message}`); return;
  }

  const modReq = intercept.applyMR(reqObj, 'request');

  intercept.pause(modReq).then(async ({ action, request: finalReq }) => {
    if (action === 'drop') {
      try { tlsClient.end(); } catch (_) {} return;
    }

    let reqId;
    try { reqId = db.insertRequest(finalReq); } catch (e) {
      console.error(`[MITM] DB insert error: ${e.message}`);
    }

    if (reqId != null) {
      bridge.emitRequest({ id:reqId, ...finalReq, req_headers:finalReq.headers, req_body:finalReq.body });
    }

    // FIX-R4: forwardRaw now always decompresses via processRawResponse
    const resObj = await forwardRaw(finalReq, hostname, port);

    // Apply match-replace BEFORE sending to browser
    const modRes     = intercept.applyMR(resObj, 'response');
    const modBodyBuf = modRes.bodyBuf instanceof Buffer && modRes.body === resObj.body
      ? modRes.bodyBuf
      : Buffer.from(modRes.body || '', 'utf8');

    const respHeaders = { ...modRes.headers };
    delete respHeaders['transfer-encoding'];
    delete respHeaders['content-encoding'];
    respHeaders['content-length'] = String(modBodyBuf.length);

    const finalStatus = modRes.status || resObj.status || 502;
    const statusLine  = `HTTP/1.1 ${finalStatus} ${modRes.statusText || reasonPhrase(finalStatus)}`;

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
          status: finalStatus, headers: modRes.headers,
          body: modRes.body, latency_ms: resObj.latency_ms,
        });
      } catch (e) { console.error(`[MITM] DB update error: ${e.message}`); }

      try {
        const full = db.getById(reqId);
        const hits = scanner.scan(full);
        if (hits.length) {
          hits.forEach(h => db.addHit({ request_id:reqId, ...h }));
          bridge.emitScannerHit(reqId, hits);
        }
      } catch (_) {}

      bridge.emitResponse({
        id: reqId, res_status: finalStatus,
        res_headers: modRes.headers, res_body: modRes.body,
        latency_ms: resObj.latency_ms,
      });
    }

    const connHeader = (modRes.headers['connection'] || '').toLowerCase();
    if (connHeader === 'close') {
      try { tlsClient.end(); } catch (_) {}
    }

  }).catch(e => {
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
  tunnel.on('error',       () => { try { clientSocket.destroy(); } catch (_) {} });
  clientSocket.on('error', () => { try { tunnel.destroy();       } catch (_) {} });
}

module.exports = { handleConnect };
