/* ============================================================
   server/ui-server.js — Séç Proxy v2.0
   Smart static file server for the UI.

   Replaces "python3 -m http.server" with a Node server that:
     - Serves all files from the ui/ folder
     - Forwards /api/* requests to the proxy server (port 8080)
     - Enables CA cert download to work correctly
     - Adds CORS headers so the UI can call the API freely
     - Serves a favicon so 404 spam stops
     - /proxy-browse?url=... — built-in browser fetch endpoint

   Usage:
     node server/ui-server.js
   Env:
     UI_PORT    (default 3000)
     PROXY_PORT (default 8080)
   ============================================================ */

'use strict';

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const zlib  = require('zlib');

const UI_PORT    = parseInt(process.env.UI_PORT    || '3000', 10);
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '8080', 10);
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

// ── Tiny 1×1 transparent PNG for favicon ────────────────────
const FAVICON = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

// ── Decompress helper ────────────────────────────────────────
function decompress(buf, enc) {
  return new Promise(res => {
    if (!enc) return res(buf);
    const e = enc.toLowerCase();
    if (e.includes('gzip'))    zlib.gunzip(buf, (er, r) => res(er ? buf : r));
    else if (e.includes('deflate')) zlib.inflate(buf, (er, r) => res(er ? buf : r));
    else if (e.includes('br')) zlib.brotliDecompress(buf, (er, r) => res(er ? buf : r));
    else res(buf);
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

// ── Forward a request to the proxy API server ─────────────────
function forwardToProxy(clientReq, clientRes, reqBody) {
  const options = {
    hostname: '127.0.0.1',
    port:     PROXY_PORT,
    path:     clientReq.url,
    method:   clientReq.method,
    headers:  {
      ...clientReq.headers,
      host: `127.0.0.1:${PROXY_PORT}`,
    },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    const headers = {
      ...proxyRes.headers,
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    };

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
      error:   'Could not reach proxy server',
      detail:  `Make sure the proxy is running on port ${PROXY_PORT}`,
      message: err.message,
    }));
  });

  if (reqBody && reqBody.length) proxyReq.write(reqBody);
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

// ── Built-in browser fetch: /proxy-browse?url=... ────────────
// Routes ALL traffic through proxy.js on port 8080 so that
// Intercept, Scanner, Match & Replace, and History all work
// exactly as if the browser had been manually configured.
async function handleProxyBrowse(parsedUrl, req, res) {
  const target = parsedUrl.searchParams.get('url');
  if (!target) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Missing ?url= parameter');
    return;
  }

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch (_) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid URL');
    return;
  }

  const reqBody = await collectBody(req);

  // ── Route through the REAL proxy (port 8080) ──────────────
  // Sending an absolute URL to proxy.js triggers full proxy
  // handling: intercept, scanner, match & replace, history.
  const options = {
    hostname: '127.0.0.1',
    port:     PROXY_PORT,          // 8080 — goes through proxy.js
    path:     target,              // absolute URL — proxy.js forwards it
    method:   req.method || 'GET',
    headers: {
      'host':            targetUrl.host,
      'user-agent':      req.headers['user-agent'] || 'SecProxy-Browser/2.0',
      'accept':          req.headers['accept'] || 'text/html,*/*',
      'accept-language': req.headers['accept-language'] || 'en-US,en;q=0.9',
      'accept-encoding': 'gzip, deflate, br',
    },
  };

  if (req.headers['content-type'])  options.headers['content-type']  = req.headers['content-type'];
  if (req.headers['authorization']) options.headers['authorization'] = req.headers['authorization'];
  if (req.headers['cookie'])        options.headers['cookie']        = req.headers['cookie'];

  const t0 = Date.now();
  const fetchReq = http.request(options, async (originRes) => {
    const chunks = [];
    originRes.on('data', c => chunks.push(c));
    originRes.on('end', async () => {
      const raw = Buffer.concat(chunks);
      const buf = await decompress(raw, originRes.headers['content-encoding']);

      const ct = originRes.headers['content-type'] || '';
      let body  = buf;

      if (ct.includes('text/html')) {
        let html = buf.toString('utf8');
        const base = `${targetUrl.protocol}//${targetUrl.host}`;
        html = html
          .replace(/(href|src|action)="(https?:\/\/[^"]+)"/gi,
            (_, attr, u) => `${attr}="/proxy-browse?url=${encodeURIComponent(u)}"`)
          .replace(/(href|src|action)="(\/[^"]*?)"/gi,
            (_, attr, u) => `${attr}="/proxy-browse?url=${encodeURIComponent(base + u)}"`)
          .replace(/<head([^>]*)>/i, `<head$1><base href="${target}">`);
        body = Buffer.from(html, 'utf8');
      }

      const respHeaders = {};
      for (const [k, v] of Object.entries(originRes.headers)) {
        const kl = k.toLowerCase();
        if (['x-frame-options', 'content-security-policy',
             'content-encoding', 'transfer-encoding'].includes(kl)) continue;
        respHeaders[k] = v;
      }
      respHeaders['content-length']     = String(body.length);
      respHeaders['x-proxy-latency-ms'] = String(Date.now() - t0);

      try {
        res.writeHead(originRes.statusCode, respHeaders);
        res.end(body);
      } catch (_) {}
    });
  });

  fetchReq.on('error', (e) => {
    res.writeHead(502, { 'Content-Type': 'text/html' });
    res.end(`<h2 style="font-family:monospace;color:#f55">Proxy Error</h2><pre>${e.message}</pre>`);
  });

  if (reqBody.length) fetchReq.write(reqBody);
  fetchReq.end();
}

// ── Main server ───────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://127.0.0.1:${UI_PORT}`);
  const pathname  = parsedUrl.pathname;

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

  // ── Favicon ─────────────────────────────────────────────────
  if (pathname === '/favicon.ico') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': FAVICON.length });
    res.end(FAVICON);
    return;
  }

  // ── Built-in browser endpoint ────────────────────────────────
  if (pathname === '/proxy-browse') {
    await handleProxyBrowse(parsedUrl, req, res);
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

  if (!filePath.startsWith(UI_ROOT)) {
    res.writeHead(403); res.end('Forbidden');
    return;
  }

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
  console.log(`[UI-Server] Forwarding /api/* → http://127.0.0.1:${PROXY_PORT}`);
  console.log(`[UI-Server] Built-in browser → http://127.0.0.1:${UI_PORT}/proxy-browse?url=https://example.com`);
  console.log(`[UI-Server] CA cert available at http://127.0.0.1:${UI_PORT}/api/ca.crt`);
});

process.on('SIGINT',  () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
