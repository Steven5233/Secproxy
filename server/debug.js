/* ============================================================
   server/debug.js — Séç Proxy traffic diagnostic
   Run: node server/debug.js
   This replaces the normal proxy temporarily with a verbose
   version that logs EVERYTHING — use to confirm traffic arrives
   ============================================================ */
'use strict';

const http = require('http');
const net  = require('net');
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '8080', 10);

let reqCount = 0;

const server = http.createServer((req, res) => {
  reqCount++;
  console.log(`\n[${reqCount}] HTTP  ${req.method} ${req.url}`);
  console.log(`       Host: ${req.headers['host'] || '(none)'}`);
  console.log(`       User-Agent: ${(req.headers['user-agent']||'').slice(0,60)}`);

  // Forward the request
  const target = new URL(req.url.startsWith('http') ? req.url : `http://${req.headers['host']}${req.url}`);
  const options = {
    hostname: target.hostname,
    port:     target.port || 80,
    path:     target.pathname + target.search,
    method:   req.method,
    headers:  { ...req.headers },
  };
  delete options.headers['proxy-connection'];

  const proxy = http.request(options, (originRes) => {
    res.writeHead(originRes.statusCode, originRes.headers);
    originRes.pipe(res);
  });
  proxy.on('error', (e) => {
    console.log(`       [!] Forward error: ${e.message}`);
    try { res.writeHead(502); res.end(e.message); } catch(_) {}
  });
  req.pipe(proxy);
});

server.on('connect', (req, socket, head) => {
  reqCount++;
  const [host, port='443'] = (req.url||'').split(':');
  console.log(`\n[${reqCount}] HTTPS CONNECT → ${host}:${port}`);
  console.log(`       User-Agent: ${(req.headers['user-agent']||'').slice(0,60)}`);

  // Simple TCP tunnel (no MITM) — just confirms traffic arrives
  const tunnel = net.connect(parseInt(port), host, () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) tunnel.write(head);
    socket.pipe(tunnel);
    tunnel.pipe(socket);
  });
  tunnel.on('error', (e) => {
    console.log(`       [!] Tunnel error: ${e.message}`);
    socket.destroy();
  });
  socket.on('error', () => tunnel.destroy());
});

server.listen(PROXY_PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║      Séç Proxy — Traffic Diagnostic          ║');
  console.log(`║      Listening on 0.0.0.0:${PROXY_PORT}              ║`);
  console.log('╠══════════════════════════════════════════════╣');
  console.log('║  Set browser proxy: 127.0.0.1:8080          ║');
  console.log('║  Browse any site — requests appear here     ║');
  console.log('║  Ctrl+C to stop                             ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
  console.log('Waiting for browser traffic...');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[!] Port ${PROXY_PORT} is already in use — stop the main proxy first`);
    console.error(`    Kill it: pkill -f proxy.js`);
  } else {
    console.error('[!]', e.message);
  }
  process.exit(1);
});
