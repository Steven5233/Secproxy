/* ============================================================
   server/ui-server.js — Séç Proxy v2.0
   Smart static file server for the UI.

   Replaces "python3 -m http.server" with a Node server that:
     - Serves all files from the ui/ folder
     - Forwards /api/* requests to the proxy server (port 8080)
     - Enables CA cert download to work correctly
     - Adds CORS headers so the UI can call the API freely
     - Serves a favicon so 404 spam stops

   Usage:
     node server/ui-server.js
   Env:
     UI_PORT    (default 3000)
     API_PORT (default 8080)
   ============================================================ */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const UI_PORT  = parseInt(process.env.UI_PORT  || '3000', 10);
const API_PORT = parseInt(process.env.API_PORT || '8888', 10); // API is separate from proxy port
const UI_ROOT    = path.join(__dirname, '..', 'ui');

// ── MIME types ───────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.crt':  'application/x-x509-ca-cert',
  '.pem':  'application/x-pem-file',
  '.txt':  'text/plain',
};

// ── Tiny 1×1 transparent PNG for favicon (stops 404 spam) ───
const FAVICON = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

// ── Forward a request to the proxy API server ─────────────────
function forwardToProxy(clientReq, clientRes, reqBody) {
  const options = {
    hostname: '127.0.0.1',
    port:     API_PORT,
    path:     clientReq.url,
    method:   clientReq.method,
    headers:  {
      ...clientReq.headers,
      host: `127.0.0.1:${API_PORT}`,
    },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    // Copy all response headers from proxy → client
    const headers = {
      ...proxyRes.headers,
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    };

    // For CA cert — ensure browser treats it as a file download
    if (clientReq.url === '/api/ca.crt') {
      headers['Content-Type']        = 'application/x-x509-ca-cert';
      headers['Content-Disposition'] = 'attachment; filename="secproxy-ca.crt"';
    }

    clientRes.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(clientRes);
  });

  proxyReq.on('error', (err) => {
    console.error(`[UI-Server] Proxy forward error: ${err.message}`);
    clientRes.writeHead(502, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({
      error: 'Could not reach proxy server',
      detail: `Make sure the proxy is running on port ${API_PORT}`,
      message: err.message,
    }));
  });

  if (reqBody && reqBody.length) {
    proxyReq.write(reqBody);
  }
  proxyReq.end();
}

// ── Serve a static file from ui/ ─────────────────────────────
function serveStatic(filePath, clientRes) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      clientRes.writeHead(404, { 'Content-Type': 'text/plain' });
      clientRes.end('404 Not Found');
      return;
    }
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    clientRes.writeHead(200, {
      'Content-Type':   mime,
      'Cache-Control':  'no-cache',
      'Content-Length': data.length,
    });
    clientRes.end(data);
  });
}

// ── Collect request body ──────────────────────────────────────
function collectBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error',() => resolve(Buffer.alloc(0)));
  });
}

// ── Main server ───────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsedUrl  = new URL(req.url, `http://127.0.0.1:${UI_PORT}`);
  const pathname   = parsedUrl.pathname;

  // ── CORS preflight ──────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    });
    res.end();
    return;
  }

  // ── Favicon (stop 404 log spam) ─────────────────────────────
  if (pathname === '/favicon.ico') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': FAVICON.length });
    res.end(FAVICON);
    return;
  }

  // ── API requests → forward to proxy server ──────────────────
  if (pathname.startsWith('/api/')) {
    const body = await collectBody(req);
    forwardToProxy(req, res, body);
    return;
  }

  // ── Static files ─────────────────────────────────────────────
  let filePath = path.join(UI_ROOT, pathname === '/' ? 'index.html' : pathname);

  // Security: prevent directory traversal
  if (!filePath.startsWith(UI_ROOT)) {
    res.writeHead(403); res.end('Forbidden');
    return;
  }

  // If path has no extension, try adding .html, else serve index
  if (!path.extname(filePath)) {
    if (fs.existsSync(filePath + '.html')) {
      filePath = filePath + '.html';
    } else {
      filePath = path.join(UI_ROOT, 'index.html');
    }
  }

  serveStatic(filePath, res);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[UI-Server] Port ${UI_PORT} is already in use. Try: UI_PORT=3001 node server/ui-server.js`);
  } else {
    console.error('[UI-Server] Error:', e.message);
  }
  process.exit(1);
});

server.listen(UI_PORT, '127.0.0.1', () => {
  console.log(`[UI-Server] Serving ui/ on http://127.0.0.1:${UI_PORT}`);
  console.log(`[UI-Server] Forwarding /api/* → http://127.0.0.1:${API_PORT}`);
  console.log(`[UI-Server] CA cert available at http://127.0.0.1:${UI_PORT}/api/ca.crt`);
});

process.on('SIGINT',  () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
