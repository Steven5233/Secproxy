/* ============================================================
   server/mitm.js — HTTPS MITM engine
   Séç Proxy v2.0

   Fixes applied:
   FIX Bug 10: isComplete() now handles chunked transfer-encoding
               by reading chunked framing to detect the terminal
               "0\r\n\r\n" chunk instead of assuming headers-only.
   FIX Bug 11: Match-replace on responses is applied to the
               accumulated buffer BEFORE streaming to the browser,
               so modifications actually reach the client.
   FIX Bug 12: parseResBuf guards sep === -1 correctly so no
               silent body corruption occurs.
   FIX Bug 13: Request is forwarded as a Buffer (not a string)
               so binary bodies (uploads, multipart) are not corrupted.
   FIX Bug 14: transparentTunnel is the correct fallback; it is
               only reached before any TLS handshake attempt, so
               the "200 Connection Established" + raw TCP tunnel
               remains valid for non-HTTPS CONNECT targets.
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

// ── Parse raw HTTP request buffer ───────────────────────────
function parseReqBuf(buf, scheme, host, port) {
  // FIX Bug 12/13: Use binary encoding throughout so binary bodies
  // are preserved exactly. Body is kept as a Buffer slice.
  const raw  = buf.toString('binary');
  const sep  = raw.indexOf('\r\n\r\n');
  // FIX Bug 12: Guard against missing header/body separator.
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
  // Keep body as Buffer for binary safety (FIX Bug 13)
  const bodyBuf = sep >= 0 ? buf.slice(sep + 4) : Buffer.alloc(0);
  return {
    method, path: rawPath, headers,
    bodyBuf,                           // raw Buffer — used when forwarding
    body: bodyBuf.toString('utf8'),    // string — stored in DB
    scheme, host, port,
    url: `${scheme}://${host}${rawPath}`,
  };
}

// ── Parse raw HTTP response buffer ──────────────────────────
function parseResBuf(buf) {
  const raw   = buf.toString('binary');
  const sep   = raw.indexOf('\r\n\r\n');
  // FIX Bug 12: Guard sep === -1. If we never got headers, treat the
  // whole buffer as an opaque body with status 0.
  if (sep < 0) {
    return { status: 0, headers: {}, body: buf.toString('utf8'), buf };
  }
  const head  = raw.slice(0, sep);
  const lines = head.split('\r\n');
  const m     = (lines[0] || '').match(/HTTP\/[\d.]+ (\d+)/);
  const status = m ? parseInt(m[1], 10) : 0;
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].indexOf(':');
    if (c < 0) continue;
    headers[lines[i].slice(0, c).trim().toLowerCase()] = lines[i].slice(c + 1).trim();
  }
  const bodyBuf = buf.slice(sep + 4);
  let bodyStr = '';
  try { bodyStr = bodyBuf.toString('utf8'); } catch (_) { bodyStr = ''; }
  return { status, headers, body: bodyStr, buf: bodyBuf };
}

// ── Get Content-Length from headers ─────────────────────────
function getContentLength(headers) {
  const cl = headers['content-length'];
  return cl !== undefined ? parseInt(cl, 10) : -1;
}

// ── FIX Bug 10: Check if we have a complete HTTP message ─────
// Handles: Content-Length, chunked transfer-encoding, and
// responses/requests with no body (header-only).
function isComplete(buf) {
  const raw = buf.toString('binary');
  const sep = raw.indexOf('\r\n\r\n');
  if (sep < 0) return false; // headers not yet fully received

  const head = raw.slice(0, sep);
  const bodyRaw = raw.slice(sep + 4);

  // Check Content-Length
  const clMatch = head.match(/content-length:\s*(\d+)/i);
  if (clMatch) {
    const cl = parseInt(clMatch[1], 10);
    return bodyRaw.length >= cl;
  }

  // FIX Bug 10: Check for chunked transfer-encoding.
  // A chunked body is complete when we see the terminal "0\r\n\r\n".
  const teMatch = head.match(/transfer-encoding:\s*chunked/i);
  if (teMatch) {
    return bodyRaw.includes('0\r\n\r\n') || bodyRaw.endsWith('0\r\n\r\n');
  }

  // No body expected (e.g. HEAD, 204, 304) — headers alone are enough.
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

  // Step 2: generate spoofed cert and wrap in TLS.
  // FIX Bug 19: getCertForHost is now async — use .then() so we don't block.
  ca.getCertForHost(hostname).then(mitmCreds => {
    _startTLS(clientSocket, hostname, port, mitmCreds);
  }).catch(e => {
    console.error(`[MITM] Cert fail for ${hostname}: ${e.message}`);
    transparentTunnel(clientSocket, hostname, port);
  });
}

// ── Internal: start TLS wrapping after cert is ready ─────────
function _startTLS(clientSocket, hostname, port, mitmCreds) {
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
    if (action === 'drop') {
      // Close connection cleanly on drop
      try { tlsClient.end(); } catch (_) {}
      return;
    }

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
      rejectUnauthorized: false,
    });

    origin.setTimeout(SOCKET_TIMEOUT);
    origin.on('timeout', () => {
      console.error(`[MITM] Origin timeout ${hostname}`);
      origin.destroy();
      tlsClient.destroy();
    });

    origin.on('error', (e) => {
      if (!['ECONNRESET', 'EPIPE', 'ECONNREFUSED'].includes(e.code)) {
        console.error(`[MITM] Origin error ${hostname}: ${e.message}`);
      }
      try { tlsClient.destroy(); } catch (_) {}
    });

    origin.on('connect', () => {
      // FIX Bug 13: Build request as a Buffer to preserve binary bodies.
      // Reconstruct header lines from finalReq.headers.
      const hlines = Object.entries(finalReq.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n');
      const requestLine = `${finalReq.method} ${finalReq.path} HTTP/1.1`;
      const headerBlock = Buffer.from(`${requestLine}\r\n${hlines}\r\n\r\n`, 'utf8');

      // Use the raw bodyBuf if available (preserved from parseReqBuf).
      // Fall back to encoding the string body for compatibility with
      // requests that came through intercept.applyMR (which operates on strings).
      const bodyBuf = finalReq.bodyBuf instanceof Buffer
        ? finalReq.bodyBuf
        : Buffer.from(finalReq.body || '', 'utf8');

      const rawReqBuf = Buffer.concat([headerBlock, bodyBuf]);
      try { origin.write(rawReqBuf); } catch (_) {}
    });

    // FIX Bug 11: Accumulate the full response before sending to client
    // so that match-replace can modify the response body.
    let resBufs = [];
    origin.on('data', (chunk) => {
      resBufs.push(chunk);
    });

    origin.on('end', () => {
      const latency = Date.now() - t0;
      const rawResBuf = Buffer.concat(resBufs);

      let resObj = { status: 0, headers: {}, body: '', buf: Buffer.alloc(0) };
      try { resObj = parseResBuf(rawResBuf); } catch (_) {}

      // FIX Bug 11: Apply match-replace BEFORE sending to browser.
      const modRes = intercept.applyMR(resObj, 'response');

      // Rebuild the response buffer with the (potentially modified) body.
      const modBodyBuf = modRes.buf && modRes.body === resObj.body
        ? modRes.buf
        : Buffer.from(modRes.body || '', 'utf8');

      // Rebuild the full HTTP response (header block + body) so the browser
      // receives a correctly framed response with the modified body.
      const respHeaders = { ...modRes.headers };
      // Ensure content-length reflects the modified body length.
      respHeaders['content-length'] = String(modBodyBuf.length);
      // Remove transfer-encoding since we're sending a complete response.
      delete respHeaders['transfer-encoding'];

      const statusLine  = `HTTP/1.1 ${modRes.status || resObj.status} OK`;
      const headerLines = Object.entries(respHeaders)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n');
      const headerBlock = Buffer.from(`${statusLine}\r\n${headerLines}\r\n\r\n`, 'utf8');
      const fullResBuf  = Buffer.concat([headerBlock, modBodyBuf]);

      // Now send the complete (potentially modified) response to the browser.
      try { tlsClient.write(fullResBuf); } catch (_) {}

      try {
        db.updateResponse(reqId, {
          status:     modRes.status || resObj.status,
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
        id:          reqId,
        res_status:  modRes.status || resObj.status,
        res_headers: modRes.headers,
        res_body:    modRes.body,
        latency_ms:  latency,
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
  const tunnel = net.connect(port, hostname, () => {
    clientSocket.pipe(tunnel);
    tunnel.pipe(clientSocket);
  });
  tunnel.on('error', () => { try { clientSocket.destroy(); } catch(_){} });
  clientSocket.on('error', () => { try { tunnel.destroy(); } catch(_){} });
}

module.exports = { handleConnect };
