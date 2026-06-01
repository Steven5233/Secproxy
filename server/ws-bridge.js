/* ============================================================
   server/ws-bridge.js — Real-time WebSocket bridge → UI
   Séç Proxy v2.0
   ============================================================ */
'use strict';

const { WebSocketServer } = require('ws');

let wss     = null;
const clients = new Set();

function start(port = 8081) {
  wss = new WebSocketServer({ port });
  wss.on('connection', (ws, req) => {
    clients.add(ws);
    console.log(`[WS] UI connected from ${req.socket.remoteAddress} — total: ${clients.size}`);
    ws.on('close', () => { clients.delete(ws); });
    ws.on('error', () => { clients.delete(ws); });
    // send handshake
    safeSend(ws, { type:'connected', ts:Date.now() });
  });
  console.log(`[WS] Bridge listening on ws://0.0.0.0:${port}`);
}

function safeSend(ws, obj) {
  try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (_) {}
}

function broadcast(type, payload) {
  if (!clients.size) return;
  const msg = JSON.stringify({ type, ts:Date.now(), ...payload });
  for (const ws of clients) {
    try { if (ws.readyState === 1) ws.send(msg); } catch (_) { clients.delete(ws); }
  }
}

module.exports = {
  start,
  broadcast,
  emitRequest(entry)              { broadcast('request',            { entry }); },
  emitResponse(entry)             { broadcast('response',           { entry }); },
  emitIntercepted(id, request)    { broadcast('intercepted',        { id, request }); },
  emitInterceptDone(id, action)   { broadcast('intercept_resolved', { id, action }); },
  emitScannerHit(requestId, hits) { broadcast('scanner_hit',        { requestId, hits }); },
  emitStats(stats)                { broadcast('stats',              { stats }); },
  emitStatus(status)              { broadcast('status',             { status }); },
};
