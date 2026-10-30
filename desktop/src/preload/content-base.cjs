// Preload for tab contents (sandboxed, isolated world, also in iframes).
//
// * ludworks:// internal pages get the `lwPage` API (the main process re-checks the sender frame).
// * Web pages get: page-first keyboard shortcuts reported back when the page did not handle them,
//   and (content-features.js, bundled after this file) autofill + the passkey bridge.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const IS_INTERNAL = location.protocol === 'ludworks:' && window === window.top;

if (IS_INTERNAL) {
  const PAGE_CHANNELS = new Set(['page-event']);
  contextBridge.exposeInMainWorld('lwPage', {
    platform: process.platform,
    call: (cmd, args) => ipcRenderer.invoke('page', String(cmd), args === undefined ? {} : args),
    on: (channel, fn) => {
      if (!PAGE_CHANNELS.has(channel) || typeof fn !== 'function') throw new Error('channel not allowed');
      const wrapped = (_e, payload) => fn(payload);
      ipcRenderer.on(channel, wrapped);
      return () => ipcRenderer.removeListener(channel, wrapped);
    },
  });
}

// ------------------------------------------------------------------ page-first shortcuts
const isMac = process.platform === 'darwin';
function pageFirstCandidate(e) {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (e.key === 'F3') return true;
  if (!mod || e.altKey) return false;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return ['f', 'g', 's', 'p', 'd', 'u', '=', '+', '-', '0'].includes(k) || e.code === 'NumpadAdd' || e.code === 'NumpadSubtract';
}
window.addEventListener(
  'keydown',
  (e) => {
    if (!e.isTrusted || !pageFirstCandidate(e)) return;
    // Decide after the event finished dispatching: handled (preventDefault) by the page → leave it.
    setTimeout(() => {
      if (e.defaultPrevented) return;
      ipcRenderer.send('content', 'shortcut', {
        key: e.key,
        code: e.code,
        control: e.ctrlKey,
        meta: e.metaKey,
        shift: e.shiftKey,
        alt: e.altKey,
      });
    }, 0);
  },
  false,
);
