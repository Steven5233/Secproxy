/* ============================================================
   mitm.js — HTTPS MITM interceptor
   Séç Proxy v2.0

   When a browser issues CONNECT host:443 the proxy calls
   handleConnect(). We:
     1. Tell the client "200 Connection established"
     2. Wrap the client socket in TLS using a spoofed cert for
        the hostname (signed by our root CA)
     3. Open a real TLS connection to the origin server
     4. Parse the now-plaintext HTTP requests and responses
     5. Route everything through intercept + scanner + db

   Import: this module does NOT start any server — it exports
   handleConnect() which proxy.js calls on CONNECT events.
   ============================================================ */

'use strict';

const tls    = require('tls');
const net    = require('net');
const http   = require('http');
const ca     = require('./ca');
const db     = require('./db');
const bridge = require('./ws-bridge');
const intercept = require('./intercept');
const scanner   = require('./scanner');

/* ── Parse a raw HTTP request buffer into parts ─────────── */
function parseRequest(buf, scheme, host, port) {
  const raw = buf.toString('utf8');
  const idx = raw.indexOf('\r\n\r\n');
  const headerPart = idx >= 0 ? raw.slice(0, idx) : raw;
  const body       = idx >= 0 ? raw.slice(idx + 4) : '';

  const lines   = headerPart.split('\r\n');
  const reqLine = lines[0] || '';
  const [method, rawPath] = reqLine.split(' ');

  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(':');
    if (colon < 0) continue;
    const k = lines[i].slice(0, colon).trim().toLowerCase();
    const v = lines[i].slice(colon + 1).trim();
    headers[k] = v;
  }

  const url = `${scheme}://${host}${rawPath || '/'}`;
  return { method, path: rawPath || '/', url, headers, body, scheme, host, port };
}

/* ── Parse a raw HTTP response buffer ───────────────────── */
function parseResponse(buf) {
  const raw = buf.toString('utf8');
  const idx = raw.indexOf('\r\n\r\n');
  const headerPart = idx >= 0 ? raw.slice(0, idx) : raw;
  const body       = idx >= 0 ? raw.slice(idx + 4) : '';

  const lines    = headerPart.split('\r\n');
  const statusLine = lines[0] || '';
  const statusMatch = statusLine.match(/HTTP\/[\d.]+ (\d+)/);
  const status  = statusMatch ? parseInt(statusMatch[1]) : 0;

  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(':');
    if (colon < 0) continue;
    const k = lines[i].slice(0, colon).trim().toLowerCase();
    const v = lines[i].slice(colon + 1).trim();
    headers[k] = v;
  }
  return { status, headers, body };
}

/* ── Main CONNECT handler ────────────────────────────────── */
function handleConnect(clientSocket, hostname, port, head) {
  /* Step 1: Acknowledge the tunnel to the browser */
  clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

  /* Step 2: Get spoofed cert and wrap client in TLS */
  let mitmCert;
  try {
    mitmCert = ca.getCertForHost(hostname);
  } catch (e) {
    console.error(`[MITM] Cert gen failed for ${hostname}:`, e.message);
    clientSocket.destroy();
    return;
  }

  const tlsServer = new tls.TLSSocket(clientSocket, {
    isServer:    true,
    key:         mitmCert.key,
    cert:        mitmCert.cert,
  });

  tlsServer.on('error', () => {});

  /* Accumulate client → proxy data */
  let reqBuf = Buffer.alloc(0);

  tlsServer.on('data', (chunk) => {
    reqBuf = Buffer.concat([reqBuf, chunk]);

    /* Wait for at least the header block */
    const str = reqBuf.toString('utf8');
    if (!str.includes('\r\n\r\n')) return;

    const reqObj = parseRequest(reqBuf, 'https', hostname, port);
    reqBuf = Buffer.alloc(0); // reset for next request (keep-alive)

    /* Apply request match-replace */
    const modReq = intercept.applyMatchReplace(reqObj, 'request');

    /* Pause if intercept is on */
    intercept.pause(modReq).then(({ action, request: finalReq }) => {
      if (action === 'drop') return;

      const reqId = db.insertRequest(finalReq);
      bridge.emitRequest({
        id: reqId, ...finalReq,
        req_headers: finalReq.headers,
        req_body:    finalReq.body,
      });

      /* Step 3: Open real TLS connection to origin */
      const t0 = Date.now();
      const originSocket = tls.connect({ host: hostname, port, servername: hostname }, () => {
        /* Build and send raw HTTP request to origin */
        const headerLines = Object.entries(finalReq.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\r\n');
        const raw =
          `${finalReq.method} ${finalReq.path} HTTP/1.1\r\n` +
          `${headerLines}\r\n\r\n` +
          (finalReq.body || '');
        originSocket.write(raw);
      });

      originSocket.on('error', (e) => {
        console.error(`[MITM] Origin error ${hostname}:`, e.message);
        tlsServer.destroy();
      });

      /* Step 4: Accumulate origin response */
      let resBuf = Buffer.alloc(0);
      originSocket.on('data', (chunk) => {
        resBuf = Buffer.concat([resBuf, chunk]);
        tlsServer.write(chunk); // forward bytes to client in real time
      });

      originSocket.on('end', () => {
        const latency = Date.now() - t0;
        let resObj = { status: 0, headers: {}, body: '' };
        try { resObj = parseResponse(resBuf); } catch (_) {}

        /* Apply response match-replace */
        const modRes = intercept.applyMatchReplace(resObj, 'response');

        db.updateResponse(reqId, {
          status:     modRes.status,
          headers:    modRes.headers,
          body:       modRes.body,
          latency_ms: latency,
        });

        /* Passive scan */
        const fullEntry = db.getById(reqId);
        const hits = scanner.scan(fullEntry);
        if (hits.length) {
          hits.forEach(h => db.addScannerHit({ request_id: reqId, ...h }));
          bridge.emitScannerHit(reqId, hits);
        }

        bridge.emitResponse({
          id:         reqId,
          res_status: modRes.status,
          res_headers: modRes.headers,
          res_body:   modRes.body,
          latency_ms: latency,
        });

        tlsServer.end();
      });

    }).catch(() => clientSocket.destroy());
  });

  tlsServer.on('end', () => {});
}

module.exports = { handleConnect };
