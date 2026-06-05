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

// ── Rewrite HTML links to stay inside the built-in browser ───
function rewriteHTML(html, target, targetUrl) {
  const base = `${targetUrl.protocol}//${targetUrl.host}`;
  return html
    .replace(/(href|src|action)="(https?:\/\/[^"]+)"/gi,
      (_, attr, u) => `${attr}="/proxy-browse?url=${encodeURIComponent(u)}"`)
    .replace(/(href|src|action)="(\/[^"]*?)"/gi,
      (_, attr, u) => `${attr}="/proxy-browse?url=${encodeURIComponent(base + u)}"`)
    .replace(/<head([^>]*)>/i, `<head$1><base href="${target}">`);
}

// ── Strip headers that break iframe rendering ─────────────────
// FIX 1: content-length included so we can set our own correct
//         value after decompression — prevents the parse error
//         "Content-Length can't be present with Transfer-Encoding"
const STRIP_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'content-encoding',
  'transfer-encoding',
  'content-length',
]);

function buildRespHeaders(originHeaders, bodyLength, latencyMs) {
  const out = {};
  for (const [k, v] of Object.entries(originHeaders)) {
    if (!STRIP_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  out['content-length']                = String(bodyLength);
  out['x-proxy-latency-ms']            = String(latencyMs);
  // Always allow fetch() from any origin — critical for browser.html
  // running inside an iframe context on Android WebView
  out['access-control-allow-origin']   = '*';
  out['access-control-allow-headers']  = '*';
  out['access-control-allow-methods']  = 'GET,POST,PUT,DELETE,OPTIONS';
  return out;
}

// ── Log request to proxy.js for intercept/history/scanner ─────
function logToProxy(method, target, targetUrl, headers, body) {
  const logReq = http.request({
    hostname: '127.0.0.1',
    port:     PROXY_PORT,
    path:     target,
    method,
    headers:  { ...headers, host: targetUrl.host },
  });
  logReq.on('error', () => {});
  if (body && body.length) logReq.write(body);
  logReq.end();
}

// ── Built-in browser fetch: /proxy-browse?url=... ─────────────
// Fetches the target URL server-side (bypasses CORS/X-Frame-Options),
// follows redirects automatically, decompresses, rewrites HTML links,
// and returns the final page to browser.html's fetch() call.
async function handleProxyBrowse(parsedUrl, req, res) {
  const target = parsedUrl.searchParams.get('url');
  if (!target) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Missing ?url= parameter');
    return;
  }

  let targetUrl;
  try { targetUrl = new URL(target); }
  catch (_) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid URL');
    return;
  }

  const reqBody = await collectBody(req);
  const method  = req.method || 'GET';

  const fwdHeaders = {
    'host':            targetUrl.host,
    'user-agent':      'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    'accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'accept-encoding': 'gzip, deflate, br',
    'connection':      'close',
    'upgrade-insecure-requests': '1',
  };
  if (req.headers['content-type'])  fwdHeaders['content-type']  = req.headers['content-type'];
  if (req.headers['authorization']) fwdHeaders['authorization'] = req.headers['authorization'];
  if (req.headers['cookie'])        fwdHeaders['cookie']        = req.headers['cookie'];

  // Log to proxy.js for capture (fire and forget)
  logToProxy(method, target, targetUrl, fwdHeaders, reqBody);

  const t0 = Date.now();

  // Follow up to 10 redirects server-side so the client never sees a redirect
  // to an external URL (which would cause "Failed to fetch" on Android WebView)
  async function doFetch(urlObj, redirectsLeft) {
    return new Promise((resolve, reject) => {
      const isHTTPS = urlObj.protocol === 'https:';
      const lib     = isHTTPS ? https : http;

      const opts = {
        hostname:           urlObj.hostname,
        port:               urlObj.port || (isHTTPS ? 443 : 80),
        path:               (urlObj.pathname || '/') + (urlObj.search || ''),
        method:             redirectsLeft < 10 ? 'GET' : method, // redirects always GET
        headers:            { ...fwdHeaders, host: urlObj.host },
        rejectUnauthorized: false,
        timeout:            20000,
      };

      const r = lib.request(opts, (originRes) => {
        const status = originRes.statusCode;

        // Follow 3xx redirects server-side
        if ([301,302,303,307,308].includes(status) && redirectsLeft > 0) {
          const loc = originRes.headers['location'];
          if (loc) {
            // Drain the body so the socket is freed
            originRes.resume();
            try {
              const nextUrl = new URL(loc, urlObj.href);
              resolve(doFetch(nextUrl, redirectsLeft - 1));
            } catch(_) {
              reject(new Error('Bad redirect location: ' + loc));
            }
            return;
          }
        }

        const chunks = [];
        originRes.on('data', c => chunks.push(c));
        originRes.on('end', () => resolve({ originRes, buf: Buffer.concat(chunks), finalUrl: urlObj.href }));
        originRes.on('error', reject);
      });

      r.on('timeout', () => { r.destroy(); reject(new Error('Request timed out after 20s')); });
      r.on('error', reject);
      if (reqBody.length && redirectsLeft === 10) r.write(reqBody);
      r.end();
    });
  }

  try {
    const { originRes, buf, finalUrl } = await doFetch(targetUrl, 10);

    const decompressed = await decompress(buf, originRes.headers['content-encoding']);
    const ct = originRes.headers['content-type'] || '';
    let body  = decompressed;

    if (ct.includes('text/html')) {
      // Use the final URL (after redirects) as the base for link rewriting
      const finalUrlObj = new URL(finalUrl);
      body = Buffer.from(rewriteHTML(decompressed.toString('utf8'), finalUrl, finalUrlObj), 'utf8');
    }

    const respHeaders = buildRespHeaders(originRes.headers, body.length, Date.now() - t0);
    // Tell browser.html what the final URL was (after redirects)
    respHeaders['x-final-url'] = finalUrl;

    try {
      res.writeHead(originRes.statusCode, respHeaders);
      res.end(body);
    } catch (_) {}

  } catch (e) {
    try {
      res.writeHead(502, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
      res.end(`<h2 style="font-family:monospace;color:#ef4444;padding:20px">Connection Error</h2><pre style="padding:0 20px;color:#94a3b8">${e.message}</pre>`);
    } catch (_) {}
  }
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
