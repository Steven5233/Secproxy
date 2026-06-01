/* ============================================================
   browser/preload.js — Preload for the Proxy UI window
   Exposes safe IPC bridge to the renderer (Proxy UI page).
   ============================================================ */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronBridge', {
  navigate: (url) => ipcRenderer.send('navigate', url),
  getURL:   ()    => ipcRenderer.invoke('getURL'),
});
