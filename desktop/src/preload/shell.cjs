// Preload for the browser UI views (lwshell://ui/…): tab strip/toolbar, popup overlay, error panel.
// Exposes a narrow message API; the main process checks that calls come from one of its own UI views.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = new Set([
  'state',
  'focus-omnibox',
  'find-open',
  'open-star',
  'open-menu',
  'open-tab-search',
  'zoom-bubble',
  'download-started',
  'download-finished',
  'fly', // fx.html: the download flyover
  'suggestions-closed',
  'popup',
  'popup-data',
  'popup-select',
  'theme',
  'panel',
  'account',
  'key-state',
  'open-account',
  'open-key',
  'tab-drop',
]);

contextBridge.exposeInMainWorld('lw', {
  platform: process.platform,
  call: (cmd, args) => ipcRenderer.invoke('shell', String(cmd), args === undefined ? {} : args),
  on: (channel, fn) => {
    if (!CHANNELS.has(channel) || typeof fn !== 'function') throw new Error(`channel not allowed: ${channel}`);
    const wrapped = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
