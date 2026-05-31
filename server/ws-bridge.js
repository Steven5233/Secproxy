/* ============================================================
   ws-bridge.js — WebSocket bridge (proxy → UI)
   Séç Proxy v2.0

   Listens on port 8081. Every connected UI tab receives all
   real-time events: new requests, responses, intercept pauses,
   scanner hits, stats.
   ============================================================ */

'use strict';

const { WebSocketServer } = require('ws');

let wss    = null;
let clients = new Set();

/* ── Start the WS server ─────────────────────────────────── */
function start(port = 8081) {
  wss = new WebSocketServer({ port });

  wss.on('connection', (ws, req) => {
    clients.add(ws);
    const ip = req.socket.remoteAddress;
    console.log(`[WS] UI connected (${ip}) — total: ${clients.size}`);

    ws.on('close', () => {
      clients.delete(ws);
      console.log(`[WS] UI disconnected — total: ${clients.size}`);
    });

    ws.on('error', () => clients.delete(ws));

    /* Send current stats on connect */
    try {
      ws.send(JSON.stringify({ type: 'connected', ts: Date.now() }));
    } catch (_) {}
  });

  console.log(`[WS] Bridge listening on ws://0.0.0.0:${port}`);
}

/* ── Broadcast to all connected UIs ─────────────────────── */
function broadcast(type, payload) {
  if (!clients.size) return;
  const msg = JSON.stringify({ type, ts: Date.now(), ...payload });
  for (const ws of clients) {
    try {
      if (ws.readyState === 1 /* OPEN */) ws.send(msg);
    } catch (_) {
      clients.delete(ws);
    }
  }
}

/* ── Typed helpers used by proxy.js ─────────────────────── */
module.exports = {
  start,
  broadcast,

  /** A new request just entered the proxy */
  emitRequest(entry) {
    broadcast('request', { entry });
  },

  /** Response received and stored */
  emitResponse(entry) {
    broadcast('response', { entry });
  },

  /** A request is paused pending intercept action */
  emitIntercepted(id, request) {
    broadcast('intercepted', { id, request });
  },

  /** Intercept resolved (forwarded or dropped) */
  emitInterceptResolved(id, action) {
    broadcast('intercept_resolved', { id, action });
  },

  /** Scanner found something */
  emitScannerHit(requestId, hits) {
    broadcast('scanner_hit', { requestId, hits });
  },

  /** General stats update */
  emitStats(stats) {
    broadcast('stats', { stats });
  },

  /** Proxy status (intercept on/off, running, etc.) */
  emitStatus(status) {
    broadcast('status', { status });
  },
};
