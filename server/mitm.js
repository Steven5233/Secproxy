/* ============================================================
   server/mitm.js — HTTPS MITM engine
   Séç Proxy v2.0

   applied:
   - Handles chunked TLS data correctly (accumulate until
     Content-Length or double CRLF, don't drop mid-request)
   - Handles keep-alive connections (multiple requests per tunnel)
   - Handles binary response bodies (images, etc.) without crashing
   - Added connection timeout to prevent hanging sockets
   - TLS errors silenced per-socket so one bad cert doesn't crash all
   ============================================================ */
'use strict';

const tls       = require('tls');
const ca        = require('./ca');
const db        = require('./db');
const bridge    = require('./ws-bridge');
const intercept = require('./intercept');
const scanner   = require('./scanner');

const SOCKET_TIMEOUT = 30000; // 30s

// ── Parse raw HTTP request buffer ───────────────────────────
function parseReqBuf(buf, scheme, host, port) {
  const raw  = buf.toString('binary'); // binary-safe
  const sep  = raw.indexOf('\r\n\r\n');
  const head = sep >= 0 ? raw.slice(0, sep) : raw;
  const body = sep >= 0 ? raw.slice(sep + 4) : '';
  const lines = head.split('\r\n');
  const parts = (lines[0] || '').split(' ');
  const method  = parts[0] || 'GET';
  const rawPath = parts[1] || '/';
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].indexOf(':');
    if (c < 0) continue;
    headers[lines[i].slice(0, c).trim().toLowerCase()] = lines[i].slice(c + 1).trim();
  }
  return {
    method, path: rawPath, headers,
    body: body || '',
    scheme, host, port,
    url: `${scheme}://${host}${rawPath}`,
  };
}

// ── Parse raw HTTP response buffer ──────────────────────────
function parseResBuf(buf) {
  const raw   = buf.toString('binary');
  const sep   = raw.indexOf('\r\n\r\n');
  const head  = sep >= 0 ? raw.slice(0, sep) : raw;
  const body  = sep >= 0 ? raw.slice(sep + 4) : '';
  const lines = head.split('\r\n');
  const m     = (lines[0] || '').match(/HTTP\/[\d.]+ (\d+)/);
  const status = m ? parseInt(m[1]) : 0;
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].indexOf(':');
    if (c < 0) continue;
    headers[lines[i].slice(0, c).trim().toLowerCase()] = lines[i].slice(c + 1).trim();
  }
  // Store body as utf8 string, falling back gracefully on binary
  let bodyStr = '';
  try { bodyStr = buf.slice(sep + 4).toString('utf8'); } catch (_) { bodyStr = body; }
  return { status, headers, body: bodyStr };
}

// ── Get Content-Length from headers ─────────────────────────
function getContentLength(headers) {
  const cl = headers['content-length'];
  return cl ? parseInt(cl, 10) : -1;
}

// ── Check if we have a complete HTTP message ─────────────────
function isComplete(buf) {
  const raw = buf.toString('binary');
  const sep = raw.indexOf('\r\n\r\n');
  if (sep < 0) return false; // headers not done yet

  // Parse headers to find Content-Length
  const head = raw.slice(0, sep);
  const match = head.match(/content-length:\s*(\d+)/i);
  if (match) {
    const cl = parseInt(match[1], 10);
    const bodyReceived = buf.length - (sep + 4);
    return bodyReceived >= cl;
  }

  // Chunked or no body — header block alone is enough to start
  return true;
}

// ── Main CONNECT handler ─────────────────────────────────────
function handleConnect(clientSocket, hostname, port) {
  // Step 1: ACK the CONNECT
  try {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  } catch (e) {
    clientSocket.destroy();
    return;
  }

  // Step 2: generate spoofed cert and wrap in TLS
  let mitmCreds;
  try {
    mitmCreds = ca.getCertForHost(hostname);
  } catch (e) {
    console.error(`[MITM] Cert fail for ${hostname}: ${e.message}`);
    // Fall back to transparent TCP tunnel so browser isn't left hanging
    transparentTunnel(clientSocket, hostname, port);
    return;
  }

  let tlsClient;
  try {
    tlsClient = new tls.TLSSocket(clientSocket, {
      isServer:  true,
      key:       mitmCreds.key,
      cert:      mitmCreds.cert,
      requestCert: false,
    });
  } catch (e) {
    console.error(`[MITM] TLS wrap fail for ${hostname}: ${e.message}`);
    clientSocket.destroy();
    return;
  }

  tlsClient.setTimeout(SOCKET_TIMEOUT);
  tlsClient.on('timeout', () => tlsClient.destroy());
  tlsClient.on('error',   () => tlsClient.destroy());

  // Accumulate request data
  let reqBuf = Buffer.alloc(0);

  tlsClient.on('data', (chunk) => {
    reqBuf = Buffer.concat([reqBuf, chunk]);

    // Wait until we have a complete HTTP message
    if (!isComplete(reqBuf)) return;

    const reqBufSnapshot = reqBuf;
    reqBuf = Buffer.alloc(0); // reset for next request (keep-alive)

    processRequest(reqBufSnapshot, hostname, port, tlsClient);
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

  // Apply match-replace rules
  const modReq = intercept.applyMR(reqObj, 'request');

  // Intercept pause (if enabled)
  intercept.pause(modReq).then(({ action, request: finalReq }) => {
    if (action === 'drop') return;

    let reqId;
    try {
      reqId = db.insertRequest(finalReq);
    } catch (e) {
      console.error(`[MITM] DB insert error: ${e.message}`);
      return;
    }

    bridge.emitRequest({
      id: reqId, ...finalReq,
      req_headers: finalReq.headers,
      req_body:    finalReq.body,
    });

    // Step 3: open real TLS connection to origin
    const t0     = Date.now();
    const origin = tls.connect({
      host:               hostname,
      port,
      servername:         hostname,
      rejectUnauthorized: false,   // we're the proxy, not verifying origin cert
    });

    origin.setTimeout(SOCKET_TIMEOUT);
    origin.on('timeout', () => {
      console.error(`[MITM] Origin timeout ${hostname}`);
      origin.destroy();
      tlsClient.destroy();
    });

    origin.on('error', (e) => {
      // Don't log noise for common connection resets
      if (!['ECONNRESET', 'EPIPE', 'ECONNREFUSED'].includes(e.code)) {
        console.error(`[MITM] Origin error ${hostname}: ${e.message}`);
      }
      tlsClient.destroy();
    });

    origin.on('connect', () => {
      // Forward request to origin
      const hlines = Object.entries(finalReq.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n');
      const rawReq = `${finalReq.method} ${finalReq.path} HTTP/1.1\r\n${hlines}\r\n\r\n${finalReq.body || ''}`;
      try { origin.write(rawReq); } catch (_) {}
    });

    // Accumulate origin response
    let resBufs = [];
    origin.on('data', (chunk) => {
      resBufs.push(chunk);
      try { tlsClient.write(chunk); } catch (_) {} // stream to browser live
    });

    origin.on('end', () => {
      const latency = Date.now() - t0;
      const resBuf  = Buffer.concat(resBufs);

      let resObj = { status: 0, headers: {}, body: '' };
      try { resObj = parseResBuf(resBuf); } catch (_) {}

      const modRes = intercept.applyMR(resObj, 'response');

      try {
        db.updateResponse(reqId, {
          status:     modRes.status,
          headers:    modRes.headers,
          body:       modRes.body,
          latency_ms: latency,
        });
      } catch (e) {
        console.error(`[MITM] DB update error: ${e.message}`);
      }

      // Passive scan
      try {
        const full = db.getById(reqId);
        const hits = scanner.scan(full);
        if (hits.length) {
          hits.forEach(h => db.addHit({ request_id: reqId, ...h }));
          bridge.emitScannerHit(reqId, hits);
        }
      } catch (_) {}

      bridge.emitResponse({
        id:         reqId,
        res_status: modRes.status,
        res_headers: modRes.headers,
        res_body:   modRes.body,
        latency_ms: latency,
      });

      try { tlsClient.end(); } catch (_) {}
    });

    origin.on('close', () => {
      try { tlsClient.end(); } catch (_) {}
    });

  }).catch((e) => {
    console.error(`[MITM] Intercept error: ${e.message}`);
    try { tlsClient.destroy(); } catch (_) {}
  });
}

// ── Transparent TCP tunnel fallback (when MITM cert fails) ──
function transparentTunnel(clientSocket, hostname, port) {
  const tunnel = require('net').connect(port, hostname, () => {
    clientSocket.pipe(tunnel);
    tunnel.pipe(clientSocket);
  });
  tunnel.on('error', () => clientSocket.destroy());
  clientSocket.on('error', () => tunnel.destroy());
}

module.exports = { handleConnect };
