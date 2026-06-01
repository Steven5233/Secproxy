/* ============================================================
   browser/browser-preload.js
   Injected into every page the built-in browser loads.
   Adds a floating address bar + status strip at the top.
   ============================================================ */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__secBridge', {
  navigate: (url) => ipcRenderer.send('navigate', url),
  getURL:   ()    => ipcRenderer.invoke('getURL'),
});

// Inject address bar after DOM is ready
window.addEventListener('DOMContentLoaded', () => {
  injectAddressBar();
});

function injectAddressBar() {
  // Avoid double-inject
  if (document.getElementById('__secBar')) return;

  const bar = document.createElement('div');
  bar.id = '__secBar';
  bar.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;
    height: 40px; background: #111418; border-bottom: 1px solid #2a3040;
    display: flex; align-items: center; gap: 6px; padding: 0 8px;
    font-family: 'JetBrains Mono', monospace; font-size: 12px;
    box-shadow: 0 2px 8px #00000088;
  `;

  bar.innerHTML = `
    <span style="color:#00ff9d;font-weight:700;font-size:11px;letter-spacing:1px;white-space:nowrap">Séç</span>
    <button id="__secBack"    style="${btnCSS()}">◀</button>
    <button id="__secFwd"     style="${btnCSS()}">▶</button>
    <button id="__secReload"  style="${btnCSS()}">↻</button>
    <input  id="__secAddr"    style="${addrCSS()}" placeholder="https://target.com" spellcheck="false">
    <button id="__secGo"      style="${goBtnCSS()}">Go</button>
    <span   id="__secScheme"  style="font-size:10px;color:#00ff9d;letter-spacing:1px;white-space:nowrap">HTTP</span>
    <span   id="__secStatus"  style="font-size:10px;color:#4a5f78;white-space:nowrap">● Proxied</span>
  `;

  document.documentElement.prepend(bar);

  // Push page content down
  const spacer = document.createElement('div');
  spacer.style.cssText = 'height:40px;width:100%;';
  document.body?.prepend(spacer);

  // Fill address bar with current URL
  const addr = document.getElementById('__secAddr');
  addr.value = location.href;
  updateScheme();

  // Events
  document.getElementById('__secBack').onclick   = () => history.back();
  document.getElementById('__secFwd').onclick    = () => history.forward();
  document.getElementById('__secReload').onclick = () => location.reload();

  document.getElementById('__secGo').onclick = () => go();
  addr.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  addr.addEventListener('focus',   () => addr.select());

  // Update bar on navigation
  window.addEventListener('popstate', () => { addr.value = location.href; updateScheme(); });

  function go() {
    let url = addr.value.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;
    window.__secBridge?.navigate(url);
  }

  function updateScheme() {
    const s = document.getElementById('__secScheme');
    const isHTTPS = location.protocol === 'https:';
    if (s) {
      s.textContent  = isHTTPS ? '🔒 HTTPS' : '⚠ HTTP';
      s.style.color  = isHTTPS ? '#00ff9d' : '#ffa502';
    }
  }
}

function btnCSS() {
  return `background:#1e242d;border:1px solid #2a3040;color:#7a8fa8;border-radius:4px;
    padding:3px 8px;cursor:pointer;font-family:inherit;font-size:12px;`;
}
function addrCSS() {
  return `flex:1;background:#1e242d;border:1px solid #2a3040;border-radius:4px;
    color:#c8d4e8;font-family:inherit;font-size:12px;padding:4px 10px;outline:none;`;
}
function goBtnCSS() {
  return `background:#00ff9d22;border:1px solid #00ff9d;color:#00ff9d;border-radius:4px;
    padding:3px 12px;cursor:pointer;font-family:inherit;font-size:11px;font-weight:700;letter-spacing:1px;`;
}
