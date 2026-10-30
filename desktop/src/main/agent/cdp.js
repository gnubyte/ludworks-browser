// One Chrome DevTools Protocol connection per agent-controlled tab, through Electron's built-in
// webContents.debugger (no remote debugging port is opened). Out-of-process iframes (cross-site frames
// under site isolation) are auto-attached as flat child sessions so snapshots and input reach them too.

import { EventEmitter } from 'node:events';

export class CdpError extends Error {}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new CdpError(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
    }),
  ]);
}

export class TabCdp extends EventEmitter {
  /** @param {Electron.WebContents} wc */
  constructor(wc) {
    super();
    this.setMaxListeners(50);
    this.wc = wc;
    this.dbg = wc.debugger;
    this.attached = false;
    this.ownsAttach = false;
    this.children = new Map(); // sessionId → {frameId, parentSession, url}
    this.onMessage = (_e, method, params, sessionId) => this.dispatch(method, params || {}, sessionId || '');
    this.onDetach = (_e, reason) => {
      this.attached = false;
      this.children.clear();
      this.dbg.off('message', this.onMessage);
      this.dbg.off('detach', this.onDetach);
      this.emit('detached', reason);
    };
  }

  async attach() {
    if (this.attached) return;
    if (this.wc.isDestroyed()) throw new CdpError('The tab is closed.');
    if (!this.dbg.isAttached()) {
      this.dbg.attach('1.3');
      this.ownsAttach = true;
    }
    this.dbg.on('message', this.onMessage);
    this.dbg.on('detach', this.onDetach);
    this.attached = true;
    await this.setupSession('');
    // the page behaves as focused (focus events, :focus, typing) while its window is in the background
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  }

  async setupSession(sessionId) {
    await this.send('Page.enable', {}, sessionId);
    await this.send('Page.setLifecycleEventsEnabled', { enabled: true }, sessionId).catch(() => {});
    await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe', exclude: false }, { exclude: true }] }, sessionId).catch(() =>
      this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId),
    );
  }

  /**
   * @param {string} method
   * @param {object} [params]
   * @param {string} [sessionId] '' = the tab's main target
   * @param {number} [timeoutMs]
   */
  send(method, params = {}, sessionId = '', timeoutMs = 15000) {
    if (!this.attached && method !== 'Page.enable') return Promise.reject(new CdpError('Not attached to the tab.'));
    let p;
    try {
      p = sessionId ? this.dbg.sendCommand(method, params, sessionId) : this.dbg.sendCommand(method, params);
    } catch (e) {
      return Promise.reject(new CdpError(e.message));
    }
    return withTimeout(Promise.resolve(p), timeoutMs, method);
  }

  dispatch(method, params, sessionId) {
    if (method === 'Target.attachedToTarget') {
      const info = params.targetInfo || {};
      if (info.type === 'iframe') {
        this.children.set(params.sessionId, { frameId: info.targetId, parentSession: sessionId, url: info.url || '' });
        this.setupSession(params.sessionId).catch(() => {});
      } else {
        this.send('Runtime.runIfWaitingForDebugger', {}, params.sessionId).catch(() => {});
      }
    } else if (method === 'Target.detachedFromTarget') {
      if (this.children.delete(params.sessionId)) this.emit('child-gone', params.sessionId);
    } else if (method === 'Target.targetInfoChanged') {
      for (const c of this.children.values()) if (c.frameId === (params.targetInfo || {}).targetId) c.url = params.targetInfo.url || c.url;
    }
    this.emit('event', method, params, sessionId);
  }

  /** The child session that renders a frame (out-of-process iframe), or '' for frames of the main target. */
  sessionForFrame(frameId) {
    for (const [sid, c] of this.children) if (c.frameId === frameId) return sid;
    return '';
  }

  /** Resolves with the params of the next `method` event (optionally matching), or rejects after ms. */
  waitEvent(method, ms, match = () => true) {
    return new Promise((resolve, reject) => {
      const on = (m, params, sid) => {
        if (m !== method || !match(params, sid)) return;
        clearTimeout(timer);
        this.off('event', on);
        resolve({ params, sessionId: sid });
      };
      const timer = setTimeout(() => {
        this.off('event', on);
        reject(new CdpError(`${method} did not happen within ${Math.round(ms / 1000)} s`));
      }, ms);
      this.on('event', on);
    });
  }

  detach() {
    if (!this.attached) return;
    this.attached = false;
    this.children.clear();
    this.dbg.off('message', this.onMessage);
    this.dbg.off('detach', this.onDetach);
    try {
      if (this.ownsAttach && !this.wc.isDestroyed() && this.dbg.isAttached()) this.dbg.detach();
    } catch {
      /* tab gone */
    }
  }
}
