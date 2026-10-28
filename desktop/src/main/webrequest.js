// One webRequest dispatcher per session. Electron keeps only the last listener registered for each
// webRequest event, so every feature that looks at network traffic (Global Privacy Control header,
// content blocker, tracking-cookie monitor) registers its handler here instead.
//
// Handlers run synchronously, in registration order, on every request: keep them fast.
//   onBeforeRequest(fn(details))                       → return {cancel: true} or {redirectURL} to stop the chain
//   onBeforeSendHeaders(fn(details, requestHeaders))   → mutate requestHeaders; return {cancel: true} to block
//   onHeadersReceived(fn(details, responseHeaders))    → mutate responseHeaders and return {changed: true}, or {cancel: true}
//   onCompleted(fn(details)) / onErrorOccurred(fn(details))
import { log } from './util/log.js';

const HUBS = new WeakMap();

export class WebRequestHub {
  /** The hub of a session (created on first use). @param {Electron.Session} ses */
  static of(ses) {
    let hub = HUBS.get(ses);
    if (!hub) {
      hub = new WebRequestHub(ses);
      HUBS.set(ses, hub);
    }
    return hub;
  }

  /** @param {Electron.Session} ses */
  constructor(ses) {
    this.lists = { before: [], send: [], received: [], completed: [], error: [] };
    const wr = ses.webRequest;
    wr.onBeforeRequest((d, cb) => {
      const r = this.chain('before', d);
      cb(r ? (r.cancel ? { cancel: true } : { redirectURL: r.redirectURL }) : {});
    });
    wr.onBeforeSendHeaders((d, cb) => {
      const headers = d.requestHeaders;
      const r = this.chain('send', d, headers);
      cb(r && r.cancel ? { cancel: true } : { requestHeaders: headers });
    });
    wr.onHeadersReceived((d, cb) => {
      if (!this.lists.received.length) return cb({});
      const headers = { ...(d.responseHeaders || {}) };
      let changed = false;
      for (const fn of this.lists.received) {
        const r = safe(fn, d, headers);
        if (r && r.cancel) return cb({ cancel: true });
        if (r && r.changed) changed = true;
      }
      cb(changed ? { responseHeaders: headers } : {});
    });
    wr.onCompleted((d) => this.each('completed', d));
    wr.onErrorOccurred((d) => this.each('error', d));
  }

  onBeforeRequest(fn) {
    this.lists.before.push(fn);
  }

  onBeforeSendHeaders(fn) {
    this.lists.send.push(fn);
  }

  onHeadersReceived(fn) {
    this.lists.received.push(fn);
  }

  onCompleted(fn) {
    this.lists.completed.push(fn);
  }

  onErrorOccurred(fn) {
    this.lists.error.push(fn);
  }

  chain(name, ...args) {
    for (const fn of this.lists[name]) {
      const r = safe(fn, ...args);
      if (r && (r.cancel || r.redirectURL)) return r;
    }
    return null;
  }

  each(name, d) {
    for (const fn of this.lists[name]) safe(fn, d);
  }
}

function safe(fn, ...args) {
  try {
    return fn(...args);
  } catch (e) {
    log.warn('webRequest handler failed', { message: e && e.message });
    return null;
  }
}
