// Picture-in-picture (Browser.registerFeature): a toolbar button when the page has a video, Ctrl+Shift+P,
// the "Picture in picture" context-menu item (also for videos inside iframes), and — optional — automatic
// picture-in-picture for a playing video when you switch to another tab, back when you return.
//
// Chromium draws the floating player itself (play/pause, back to tab, close); we only pick the video and
// call requestPictureInPicture() in its frame with a user gesture (executeJavaScript(code, true)).
import { log } from './util/log.js';

// Runs in a frame (main world): finds the best video and, with `act`, toggles picture-in-picture on it.
// Best = playing beats paused, then the largest visible one. Returns a summary for the toolbar.
const FRAME_SCRIPT = (act, point) => `(() => {
  const act = ${JSON.stringify(act)};
  const point = ${JSON.stringify(point || null)};
  const vids = [...document.querySelectorAll('video')].filter((v) => !v.disablePictureInPicture && v.readyState > 0);
  const area = (v) => { const r = v.getBoundingClientRect(); return Math.max(0, r.width) * Math.max(0, r.height); };
  const playing = (v) => !v.paused && !v.ended;
  let best = null;
  if (point) {
    const el = document.elementFromPoint(point.x, point.y);
    best = el && (el.tagName === 'VIDEO' ? el : el.closest && el.closest('video'));
  }
  if (!best) best = vids.slice().sort((a, b) => (playing(b) - playing(a)) || (area(b) - area(a)))[0] || null;
  const inPip = !!document.pictureInPictureElement;
  const out = { count: vids.length, playing: vids.some(playing), inPip, score: best ? (playing(best) ? 1e9 : 0) + area(best) : -1, audible: !!(best && playing(best) && !best.muted && best.volume > 0) };
  if (act === 'exit' && inPip) return document.exitPictureInPicture().then(() => ({ ...out, inPip: false }), () => out);
  if (act === 'enter' && best && document.pictureInPictureEnabled) return best.requestPictureInPicture().then(() => ({ ...out, inPip: true }), (e) => ({ ...out, error: String(e && e.name) }));
  return out;
})()`;

const SCAN_DELAY = 400;

export class Pip {
  /** @param {import('./browser.js').Browser} browser */
  constructor(browser) {
    this.b = browser;
    this.name = 'pip';
    this.state = new WeakMap(); // tab → {count, playing, inPip, auto}
    this.timers = new WeakMap();
    this.watcher = null;
  }

  // ------------------------------------------------------------------------------------- frames
  frames(tab) {
    if (!tab || tab.wc.isDestroyed()) return [];
    try {
      return tab.wc.mainFrame.framesInSubtree.filter((f) => !f.isDestroyed() && !/^(ludworks|lwshell|chrome-extension|devtools|chrome):/i.test(f.url || ''));
    } catch {
      return [];
    }
  }

  async run(frame, act, point) {
    try {
      return await frame.executeJavaScript(FRAME_SCRIPT(act, point), act === 'enter' || act === 'exit');
    } catch {
      return null; // frame navigated away or went cross-process
    }
  }

  /** Summarises every frame of a tab: how many videos, whether one plays, whether one is in PiP. */
  async scan(tab) {
    const results = (await Promise.all(this.frames(tab).map(async (f) => ({ f, r: await this.run(f, 'scan') })))).filter((x) => x.r);
    const s = this.state.get(tab) || {};
    const next = {
      ...s,
      count: results.reduce((n, x) => n + x.r.count, 0),
      playing: results.some((x) => x.r.playing),
      inPip: results.some((x) => x.r.inPip),
    };
    if (!next.inPip) next.auto = false;
    this.state.set(tab, next);
    if (s.count !== next.count || s.playing !== next.playing || s.inPip !== next.inPip) this.b.refreshToolbar(tab.ctl);
    this.watch();
    return results;
  }

  scheduleScan(tab, delay = SCAN_DELAY) {
    clearTimeout(this.timers.get(tab));
    this.timers.set(
      tab,
      setTimeout(() => this.scan(tab).catch(() => {}), delay),
    );
  }

  /** While some tab shows picture-in-picture, rescan now and then: the user can close the floating window. */
  watch() {
    const any = this.b.allTabs().some((t) => (this.state.get(t) || {}).inPip);
    if (any && !this.watcher) this.watcher = setInterval(() => this.b.allTabs().forEach((t) => (this.state.get(t) || {}).inPip && this.scan(t).catch(() => {})), 2000);
    if (!any && this.watcher) {
      clearInterval(this.watcher);
      this.watcher = null;
    }
  }

  /** Called for every new tab (Browser.onTabCreated): rescan when media starts/stops or the page changes. */
  attachTab(tab) {
    const again = () => this.scheduleScan(tab);
    tab.wc.on('media-started-playing', again);
    tab.wc.on('media-paused', again);
    tab.wc.on('did-finish-load', again);
    tab.wc.on('did-navigate', () => {
      this.state.set(tab, { count: 0, playing: false, inPip: false, auto: false });
      this.b.refreshToolbar(tab.ctl);
    });
    tab.wc.on('did-navigate-in-page', again);
  }

  // ------------------------------------------------------------------------------------- toggling
  /** Toggles picture-in-picture for the best video of the tab (or the one at a context-menu point). */
  async toggle(tab, { frame = null, point = null } = {}) {
    if (!tab) return false;
    const results = await this.scan(tab);
    const inPip = results.filter((x) => x.r.inPip);
    if (inPip.length) {
      await Promise.all(inPip.map((x) => this.run(x.f, 'exit')));
      return this.after(tab, false);
    }
    let target = frame && !frame.isDestroyed() ? frame : null;
    if (!target) {
      const best = results.filter((x) => x.r.count).sort((a, b) => b.r.score - a.r.score)[0];
      target = best ? best.f : null;
    }
    if (!target) return false;
    const r = await this.run(target, 'enter', target === tab.wc.mainFrame ? point : null);
    if (r && r.error) log.info('picture-in-picture refused', { error: r.error });
    return this.after(tab, !!(r && r.inPip));
  }

  async after(tab, inPip) {
    const s = this.state.get(tab) || {};
    this.state.set(tab, { ...s, inPip, auto: inPip ? s.auto : false });
    this.b.refreshToolbar(tab.ctl);
    this.watch();
    return inPip;
  }

  /** Context-menu "Picture in picture": the video under the pointer (main frame) or in the clicked iframe. */
  toggleAt(tab, params) {
    const frame = params && params.frame && !params.frame.isDestroyed() ? params.frame : null;
    return this.toggle(tab, { frame, point: params ? { x: Number(params.x) || 0, y: Number(params.y) || 0 } : null }).catch(() => false);
  }

  /** Automatic picture-in-picture: a playing video leaves with its tab and comes back with it. */
  async onTabSwitch(ctl, from, to) {
    if (!this.b.prefs.get('autoPip')) return;
    const back = to && this.state.get(to);
    if (back && back.inPip && back.auto) {
      await this.toggle(to);
      return;
    }
    if (!from || from.wc.isDestroyed()) return;
    const results = await this.scan(from);
    if (!results.some((x) => x.r.playing) || results.some((x) => x.r.inPip)) return;
    if (await this.toggle(from)) this.state.set(from, { ...this.state.get(from), auto: true });
  }

  // ------------------------------------------------------------------------------------- toolbar
  toolbarButtons(ctl, tab) {
    if (!this.b.prefs.get('pipButton')) return [];
    const s = (tab && this.state.get(tab)) || {};
    if (!s.count && !s.inPip) return [];
    return [{ id: 'pip', order: 5, icon: 'pip', pressed: !!s.inPip, title: s.inPip ? 'Exit picture in picture (Ctrl+Shift+P)' : 'Picture in picture (Ctrl+Shift+P)' }];
  }

  onButton(ctl, id, _anchor, { menu }) {
    if (menu) return null;
    return this.toggle(ctl.activeTab());
  }
}
