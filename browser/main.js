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
    // FIX Bug 20: stdout chunks are not line-buffered — accumulate into a
    // growing buffer and search it for the RUNNING marker to avoid missing
    // it when it spans two chunks.
    let stdoutBuf = '';
    let resolved  = false;
    proxyProc.stdout.on('data', d => {
      stdoutBuf += d.toString();
      process.stdout.write('[proxy] ' + d);
      if (!resolved && stdoutBuf.includes('RUNNING')) {
        resolved = true;
        resolve();
      }
    });
    proxyProc.stderr.on('data', d => process.stderr.write('[proxy-err] ' + d));
    proxyProc.on('exit', code => { if (code) console.error(`[proxy] exited with code ${code}`); });

    // Fallback resolve after 6 seconds if the RUNNING marker never appears.
    setTimeout(() => { if (!resolved) { resolved = true; resolve(); } }, 6000);
  });
}

// ── Serve the static UI from ui/ folder ──────────────────────
function startUIServer() {
  return new Promise((resolve) => {
    // Fork the shared ui-server.js (same server used in Termux mode)
    // It correctly serves static files AND proxies /api/* to the proxy port.
    const uiServerPath = path.join(__dirname, '..', 'server', 'ui-server.js');
    uiServer = fork(uiServerPath, [], {
      env: { ...process.env, UI_PORT, PROXY_PORT },
      stdio: 'pipe',
    });
    uiServer.stdout.on('data', (d) => {
      const line = d.toString();
      process.stdout.write('[ui] ' + line);
      if (line.includes('Serving ui/')) resolve();
    });
    uiServer.stderr.on('data', (d) => process.stderr.write('[ui-err] ' + d));
    // Fallback resolve after 3s
    setTimeout(resolve, 3000);
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

  // ── FIX Bug 21: Scope TLS bypass to only connections going through
  // the proxy (i.e. not the UI server at 127.0.0.1 or localhost).
  // We trust proxy-intercepted certs because we generated them; we
  // still verify the UI server connection normally.
  ses.setCertificateVerifyProc((request, callback) => {
    const host = request.hostname || '';
    // Trust any cert that came through our MITM proxy (non-loopback hosts).
    // Loopback connections (UI server, localhost) use the system verifier (callback(-3)).
    if (host === '127.0.0.1' || host === 'localhost') {
      callback(-3); // use Chromium's default verification
    } else {
      callback(0);  // trust — our MITM cert
    }
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
  if (uiServer)  uiServer.kill();   // now a child process, not http.Server
  app.quit();
});

app.on('activate', () => {
  if (!mainWin)    createProxyUI();
  if (!browserWin) createBrowser();
});
