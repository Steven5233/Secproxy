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

// ── One HTTP/HTTPS request, returns a Promise ────────────────
function doRequest(lib, opts, body) {
  return new Promise((resolve, reject) => {
    const r = lib.request(opts, (res) => resolve(res));
    r.on('timeout', () => { r.destroy(); reject(new Error('Request timed out')); });
    r.on('error',   (e) => reject(e));
    if (body && body.length) r.write(body);
    r.end();
  });
}

// ── Collect all chunks from a response stream ─────────────────
function collectResponse(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data',  (c) => chunks.push(c));
    res.on('end',   ()  => resolve(Buffer.concat(chunks)));
    res.on('error', (e) => reject(e));
  });
}

// ── Follow redirects server-side, return final response ───────
async function fetchFollowRedirects(startUrl, method, headers, body, maxRedirects) {
  let urlObj  = startUrl;
  let reqBody = body;
  let reqMethod = method;

  for (let i = 0; i <= maxRedirects; i++) {
    const isHTTPS = urlObj.protocol === 'https:';
    const lib     = isHTTPS ? https : http;
    const opts    = {
      hostname:           urlObj.hostname,
      port:               urlObj.port || (isHTTPS ? 443 : 80),
      path:               (urlObj.pathname || '/') + (urlObj.search || ''),
      method:             reqMethod,
      headers:            Object.assign({}, headers, { host: urlObj.host }),
      rejectUnauthorized: false,
      timeout:            20000,
    };

    const originRes = await doRequest(lib, opts, reqBody);
    const status    = originRes.statusCode;

    if ([301, 302, 303, 307, 308].includes(status)) {
      const loc = originRes.headers['location'];
      if (loc && i < maxRedirects) {
        // Drain body to free socket
        originRes.resume();
        // 303 and most 301/302 become GET with no body
        if ([301, 302, 303].includes(status)) {
          reqMethod = 'GET';
          reqBody   = null;
        }
        try   { urlObj = new URL(loc, urlObj.href); }
        catch (_) { throw new Error('Invalid redirect location: ' + loc); }
        continue;
      }
    }

    // Not a redirect (or ran out) — collect and return
    const buf = await collectResponse(originRes);
    return { originRes, buf, finalUrl: urlObj.href };
  }

  throw new Error('Too many redirects');
}

// ── Built-in browser fetch: /proxy-browse?url=... ─────────────
async function handleProxyBrowse(parsedUrl, req, res) {
  const target = parsedUrl.searchParams.get('url');
  if (!target) {
    res.writeHead(400, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('Missing ?url= parameter');
    return;
  }

  let targetUrl;
  try { targetUrl = new URL(target); }
  catch (_) {
    res.writeHead(400, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('Invalid URL: ' + target);
    return;
  }

  const reqBody = await collectBody(req);
  const method  = req.method || 'GET';

  const fwdHeaders = {
    'host':                    targetUrl.host,
    'user-agent':              'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    'accept':                  'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'accept-language':         'en-US,en;q=0.9',
    'accept-encoding':         'gzip, deflate, br',
    'connection':              'close',
    'upgrade-insecure-requests': '1',
  };
  if (req.headers['content-type'])  fwdHeaders['content-type']  = req.headers['content-type'];
  if (req.headers['authorization']) fwdHeaders['authorization'] = req.headers['authorization'];
  if (req.headers['cookie'])        fwdHeaders['cookie']        = req.headers['cookie'];

  // Log to proxy.js for capture — fire and forget
  logToProxy(method, target, targetUrl, fwdHeaders, reqBody);

  const t0 = Date.now();

  try {
    const { originRes, buf, finalUrl } = await fetchFollowRedirects(
      targetUrl, method, fwdHeaders, reqBody, 10
    );

    const decompressed = await decompress(buf, originRes.headers['content-encoding']);
    const ct           = originRes.headers['content-type'] || '';
    let   body         = decompressed;

    if (ct.includes('text/html')) {
      const finalUrlObj = new URL(finalUrl);
      const rewritten   = rewriteHTML(decompressed.toString('utf8'), finalUrl, finalUrlObj);
      body = Buffer.from(rewritten, 'utf8');
    }

    const respHeaders = buildRespHeaders(originRes.headers, body.length, Date.now() - t0);
    respHeaders['x-final-url'] = finalUrl;

    res.writeHead(originRes.statusCode, respHeaders);
    res.end(body);

  } catch (e) {
    console.error('[proxy-browse] Error fetching', target, ':', e.message);
    // Always respond so the browser's fetch() gets a proper response
    // instead of a connection reset (which shows as "Failed to fetch")
    const errHtml = `<!DOCTYPE html><html><body style="font-family:monospace;background:#0a0c0f;color:#e2e8f0;padding:24px;">
<h2 style="color:#ef4444;">Connection Error</h2>
<p style="color:#94a3b8;margin-top:8px;">${e.message}</p>
<p style="color:#64748b;margin-top:4px;font-size:12px;">Target: ${target}</p>
</body></html>`;
    try {
      if (!res.headersSent) {
        res.writeHead(502, {
          'Content-Type':                'text/html; charset=utf-8',
          'Content-Length':              String(Buffer.byteLength(errHtml)),
          'Access-Control-Allow-Origin': '*',
        });
        res.end(errHtml);
      }
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
