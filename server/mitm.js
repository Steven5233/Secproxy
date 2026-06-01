/* ============================================================
   server/mitm.js — HTTPS MITM engine
   Séç Proxy v2.0

   Called by proxy.js on every HTTP CONNECT request.
   Flow:
     1. ACK the CONNECT tunnel to the browser
     2. Wrap client socket in TLS with a spoofed cert
     3. Open real TLS connection to origin server
     4. Parse decrypted HTTP, run through intercept + scanner
   ============================================================ */
'use strict';

const tls       = require('tls');
const https     = require('https');
const ca        = require('./ca');
const db        = require('./db');
const bridge    = require('./ws-bridge');
const intercept = require('./intercept');
const scanner   = require('./scanner');

// ── Parse raw HTTP request buffer ───────────────────────────
function parseReqBuf(buf, scheme, host, port) {
  const raw  = buf.toString('utf8');
  const sep  = raw.indexOf('\r\n\r\n');
  const head = sep >= 0 ? raw.slice(0, sep) : raw;
  const body = sep >= 0 ? raw.slice(sep + 4) : '';
  const lines = head.split('\r\n');
  const [method, rawPath = '/'] = (lines[0] || '').split(' ');
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].indexOf(':');
    if (c < 0) continue;
    headers[lines[i].slice(0,c).trim().toLowerCase()] = lines[i].slice(c+1).trim();
  }
  return {
    method: method||'GET', path:rawPath, headers, body,
    scheme, host, port,
    url:`${scheme}://${host}${rawPath}`,
  };
}

// ── Parse raw HTTP response buffer ──────────────────────────
function parseResBuf(buf) {
  const raw  = buf.toString('utf8');
  const sep  = raw.indexOf('\r\n\r\n');
  const head = sep >= 0 ? raw.slice(0, sep) : raw;
  const body = sep >= 0 ? raw.slice(sep + 4) : '';
  const lines  = head.split('\r\n');
  const m      = (lines[0]||'').match(/HTTP\/[\d.]+ (\d+)/);
  const status = m ? parseInt(m[1]) : 0;
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].indexOf(':');
    if (c < 0) continue;
    headers[lines[i].slice(0,c).trim().toLowerCase()] = lines[i].slice(c+1).trim();
  }
  return { status, headers, body };
}

// ── Main CONNECT handler ─────────────────────────────────────
function handleConnect(clientSocket, hostname, port) {
  // Step 1: tell browser tunnel is ready
  clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

  // Step 2: wrap browser socket in TLS with spoofed cert
  let mitmCreds;
  try { mitmCreds = ca.getCertForHost(hostname); }
  catch (e) { console.error(`[MITM] Cert fail ${hostname}: ${e.message}`); clientSocket.destroy(); return; }

  const tlsClient = new tls.TLSSocket(clientSocket, {
    isServer: true,
    key:  mitmCreds.key,
    cert: mitmCreds.cert,
  });

  tlsClient.on('error', () => {});

  let reqBuf = Buffer.alloc(0);

  tlsClient.on('data', (chunk) => {
    reqBuf = Buffer.concat([reqBuf, chunk]);
    if (!reqBuf.toString('utf8').includes('\r\n\r\n')) return;

    const reqObj = parseReqBuf(reqBuf, 'https', hostname, port);
    reqBuf = Buffer.alloc(0);

    // Apply match-replace on request
    const modReq = intercept.applyMR(reqObj, 'request');

    // Pause if intercept is on
    intercept.pause(modReq).then(({ action, request: finalReq }) => {
      if (action === 'drop') return;

      const reqId = db.insertRequest(finalReq);
      bridge.emitRequest({ id:reqId, ...finalReq, req_headers:finalReq.headers, req_body:finalReq.body });

      // Step 3: real TLS connection to origin
      const t0 = Date.now();
      const origin = tls.connect({ host:hostname, port, servername:hostname }, () => {
        // Rebuild and forward raw HTTP to origin
        const hlines = Object.entries(finalReq.headers).map(([k,v]) => `${k}: ${v}`).join('\r\n');
        origin.write(`${finalReq.method} ${finalReq.path} HTTP/1.1\r\n${hlines}\r\n\r\n${finalReq.body||''}`);
      });

      origin.on('error', (e) => {
        console.error(`[MITM] Origin error ${hostname}: ${e.message}`);
        tlsClient.destroy();
      });

      let resBuf = Buffer.alloc(0);
      origin.on('data', (chunk) => {
        resBuf = Buffer.concat([resBuf, chunk]);
        tlsClient.write(chunk);   // stream bytes to browser immediately
      });

      origin.on('end', () => {
        const latency = Date.now() - t0;
        let resObj = { status:0, headers:{}, body:'' };
        try { resObj = parseResBuf(resBuf); } catch (_) {}

        const modRes = intercept.applyMR(resObj, 'response');
        db.updateResponse(reqId, { status:modRes.status, headers:modRes.headers, body:modRes.body, latency_ms:latency });

        // Passive scan
        const full = db.getById(reqId);
        const hits = scanner.scan(full);
        if (hits.length) {
          hits.forEach(h => db.addHit({ request_id:reqId, ...h }));
          bridge.emitScannerHit(reqId, hits);
        }

        bridge.emitResponse({ id:reqId, res_status:modRes.status, res_headers:modRes.headers, res_body:modRes.body, latency_ms:latency });
        tlsClient.end();
      });

    }).catch(() => clientSocket.destroy());
  });
}

module.exports = { handleConnect };
