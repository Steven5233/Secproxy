/* ============================================================
   browser/main.js — Séç Proxy v2.0 Built-in Browser
   Electron main process.

   What it does automatically:
   1. Starts the Node proxy server (server/proxy.js) as a child
   2. Opens the Proxy UI window (localhost:3000)
   3. Opens a second "Target Browser" window pre-configured to
      route ALL traffic through 127.0.0.1:8080
   No manual proxy configuration needed ever.
   ============================================================ */

'use strict';

const { app, BrowserWindow, BrowserView, Menu, ipcMain,
        session, dialog, nativeTheme } = require('electron');
const path   = require('path');
const { fork } = require('child_process');
const http   = require('http');

const PROXY_PORT = parseInt(process.env.PROXY_PORT || '8080', 10);
const UI_PORT    = parseInt(process.env.UI_PORT    || '3000', 10);
const WS_PORT    = parseInt(process.env.WS_PORT    || '8081', 10);

let proxyProc  = null;   // child_process for proxy server
let uiServer   = null;   // http server for static UI files
let mainWin    = null;   // Proxy UI window
let browserWin = null;   // Built-in target browser window

nativeTheme.themeSource = 'dark';

// ── Start the proxy server child process ─────────────────────
function startProxyServer() {
  return new Promise((resolve) => {
    const serverPath = path.join(__dirname, '..', 'server', 'proxy.js');
    proxyProc = fork(serverPath, [], {
      env: { ...process.env, PROXY_PORT, WS_PORT },
      stdio: 'pipe',
    });
    proxyProc.stdout.on('data', d => {
      const line = d.toString();
      process.stdout.write('[proxy] ' + line);
      if (line.includes('RUNNING')) resolve();
    });
    proxyProc.stderr.on('data', d => process.stderr.write('[proxy-err] ' + d));
    proxyProc.on('exit', code => { if (code) console.error(`[proxy] exited with code ${code}`); });

    // Fallback resolve after 4 seconds if stdout message missed
    setTimeout(resolve, 4000);
  });
}

// ── Serve the static UI from ui/ folder ──────────────────────
function startUIServer() {
  return new Promise((resolve) => {
    const fs   = require('fs');
    const mime = {
      '.html': 'text/html',
      '.css':  'text/css',
      '.js':   'application/javascript',
      '.json': 'application/json',
      '.png':  'image/png',
      '.ico':  'image/x-icon',
      '.svg':  'image/svg+xml',
    };
    const uiRoot = path.join(__dirname, '..', 'ui');

    uiServer = http.createServer((req, res) => {
      let filePath = path.join(uiRoot, req.url === '/' ? 'index.html' : req.url);
      filePath = filePath.split('?')[0];
      const ext = path.extname(filePath);
      fs.readFile(filePath, (err, data) => {
        if (err) {
          // forward /api/* to the proxy server
          if (req.url.startsWith('/api/')) {
            const opts = { hostname:'127.0.0.1', port:PROXY_PORT, path:req.url, method:req.method, headers:req.headers };
            const proxyReq = http.request(opts, proxyRes => {
              res.writeHead(proxyRes.statusCode, proxyRes.headers);
              proxyRes.pipe(res);
            });
            proxyReq.on('error', () => { res.writeHead(502); res.end('Proxy API error'); });
            req.pipe(proxyReq);
            return;
          }
          res.writeHead(404); res.end('Not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
        res.end(data);
      });
    });

    uiServer.listen(UI_PORT, '127.0.0.1', () => {
      console.log(`[UI] Serving on http://127.0.0.1:${UI_PORT}`);
      resolve();
    });
  });
}

// ── Create the Proxy UI window ────────────────────────────────
function createProxyUI() {
  mainWin = new BrowserWindow({
    width:  1280,
    height: 860,
    minWidth: 800,
    title:  'Séç Proxy v2.0',
    backgroundColor: '#0a0c0f',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWin.loadURL(`http://127.0.0.1:${UI_PORT}`);
  mainWin.setTitle('Séç Proxy v2.0 — Proxy UI');

  mainWin.webContents.on('did-fail-load', () => {
    setTimeout(() => mainWin.loadURL(`http://127.0.0.1:${UI_PORT}`), 1500);
  });

  mainWin.on('closed', () => { mainWin = null; });
}

// ── Create the built-in target browser window ─────────────────
function createBrowser() {
  browserWin = new BrowserWindow({
    width:  1100,
    height: 820,
    minWidth: 600,
    title:  'Séç Proxy — Built-in Browser',
    backgroundColor: '#0a0c0f',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'browser-preload.js'),
      // Route ALL traffic through the proxy automatically
      proxyBypassRules: '<local>',
    },
  });

  // ── Force the browser's session to use our proxy ──────────
  const ses = browserWin.webContents.session;
  ses.setProxy({ proxyRules: `http=127.0.0.1:${PROXY_PORT};https=127.0.0.1:${PROXY_PORT}` })
    .then(() => {
      console.log(`[Browser] Proxy set to 127.0.0.1:${PROXY_PORT}`);
      browserWin.loadURL('https://example.com');
    });

  // ── Install CA cert so HTTPS works without warnings ───────
  const caPath = path.join(__dirname, '..', 'server', 'ca', 'secproxy-ca.crt');
  ses.setCertificateVerifyProc((request, callback) => {
    // Trust everything — we're the MITM
    callback(0);
  });

  // ── Address bar / navigation menu ─────────────────────────
  const navMenu = Menu.buildFromTemplate([
    {
      label: 'Navigate',
      submenu: [
        { label: 'Back',    click: () => browserWin?.webContents.goBack() },
        { label: 'Forward', click: () => browserWin?.webContents.goForward() },
        { label: 'Reload',  click: () => browserWin?.webContents.reload() },
        { type: 'separator' },
        {
          label: 'Go to URL…', click: () => {
            browserWin?.webContents.executeJavaScript(`window.__secGo && window.__secGo()`);
          },
        },
      ],
    },
    {
      label: 'Proxy',
      submenu: [
        { label: 'Open Proxy UI', click: () => { if (mainWin) mainWin.focus(); else createProxyUI(); } },
        { label: 'Toggle Intercept', click: () => {
          http.get(`http://127.0.0.1:${PROXY_PORT}/api/intercept/toggle`, () => {});
        }},
      ],
    },
    {
      label: 'DevTools',
      submenu: [
        { label: 'Open DevTools', click: () => browserWin?.webContents.openDevTools() },
      ],
    },
  ]);
  Menu.setApplicationMenu(navMenu);

  browserWin.on('closed', () => { browserWin = null; });
}

// ── IPC from renderer (address bar) ──────────────────────────
ipcMain.on('navigate', (event, url) => {
  if (!browserWin) return;
  let target = url.trim();
  if (!target.startsWith('http://') && !target.startsWith('https://')) {
    target = 'https://' + target;
  }
  browserWin.loadURL(target);
});

ipcMain.handle('getURL', () => {
  return browserWin?.webContents.getURL() || '';
});

// ── App lifecycle ─────────────────────────────────────────────
app.whenReady().then(async () => {
  console.log('[App] Starting Séç Proxy…');
  await startProxyServer();
  await startUIServer();
  createProxyUI();
  createBrowser();
  console.log('[App] All components running.');
});

app.on('window-all-closed', () => {
  if (proxyProc) proxyProc.kill();
  if (uiServer)  uiServer.close();
  app.quit();
});

app.on('activate', () => {
  if (!mainWin)    createProxyUI();
  if (!browserWin) createBrowser();
});
