// "Send to AI" (Browser.registerFeature): a toolbar badge that hands the current page — its address, or a
// snapshot (HTML/CSS/JS and a screenshot) — to Vision, OpenClaw or Claude together with what the user wants
// done, and can let that app control the page (AgentHub.grantControl; the window then glows and says so).
// Which apps show is set during setup (welcome page) or in Settings → AI agents. Prompts and helpers:
// handoff.js.

import { app, clipboard, shell } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { HARNESSES, enabledHarnesses, handoffDirName, handoffPrompt, claudeLink, openclawHookConfig, openclawRequest, openclawError, visionCandidates, visionLaunch } from './handoff.js';
import { log } from '../util/log.js';

const KEEP_HANDOFFS = 7 * 24 * 3600 * 1000;
const SENDABLE = /^(https?|file):/i;

export class SendToAi {
  /** @param {import('../browser.js').Browser} browser */
  constructor(browser) {
    this.name = 'send';
    this.b = browser;
    this.popups = ['send-ai'];
    this.pagePrefix = 'send.';
    this.pages = ['settings', 'welcome'];
    browser.prefs.on('change', (keys) => {
      if (keys.includes('sendTo')) browser.refreshToolbar();
    });
    setTimeout(() => this.prune(), 60 * 1000).unref();
  }

  get root() {
    return path.join(os.tmpdir(), 'Ludworks Browser handoffs');
  }

  enabled() {
    return enabledHarnesses(this.b.prefs.get('sendTo'));
  }

  // ------------------------------------------------------------------------------ toolbar
  toolbarButtons(ctl, tab) {
    if (ctl.private || ctl.agent || !tab || !SENDABLE.test(tab.wc.getURL()) || !this.enabled().length) return [];
    const c = this.b.agent && this.b.agent.controlOf(tab);
    return [{ id: 'send-ai', order: 4, icon: 'send', title: c ? `Send this page to an AI app — ${c.client} controls it now` : 'Send this page to an AI app', pressed: !!c, popup: { kind: 'send-ai', width: 380 } }];
  }

  openPopup(ctl, kind, anchor) {
    const tab = ctl.activeTab();
    const url = tab ? tab.wc.getURL() : '';
    const last = this.b.db.getMeta('send_last', null) || {};
    const harnesses = this.enabled().map((id) => ({ id, name: HARNESSES[id].name, ...this.readiness(id) }));
    const data = {
      page: { title: tab ? tab.title || tab.wc.getTitle() : '', url },
      harnesses,
      last: { harness: harnesses.some((x) => x.id === last.harness) ? last.harness : harnesses[0] && harnesses[0].id, mode: last.mode === 'url' ? 'url' : 'snapshot', control: !!last.control },
      control: tab && this.b.agent ? this.b.agent.controlOf(tab) : null,
      agentOn: !!(this.b.agent && this.b.agent.on),
    };
    return ctl.showPopup(kind, data, { ...anchor, width: 380 });
  }

  async popupAction(ctl, kind, action, d) {
    const tab = ctl.activeTab();
    if (action === 'settings') {
      ctl.hidePopup(kind);
      const t = this.b.openInternal(ctl, 'settings');
      if (t) setTimeout(() => !t.wc.isDestroyed() && t.wc.executeJavaScript("location.hash = '#send-to-ai'", true).catch(() => {}), 300);
      return null;
    }
    if (action === 'stop-control') {
      if (tab && this.b.agent) this.b.agent.revokeControl(tab);
      return { ok: true, message: 'Control stopped.' };
    }
    if (action !== 'send') return null;
    const id = String((d && d.harness) || '');
    if (!this.enabled().includes(id)) return { ok: false, message: 'That app is not turned on.' };
    if (!tab || !SENDABLE.test(tab.wc.getURL())) return { ok: false, message: 'This tab has no web page to send.' };
    const mode = d.mode === 'url' ? 'url' : 'snapshot';
    const control = !!d.control;
    this.b.db.setMeta('send_last', { harness: id, mode, control });
    try {
      return await this.send(tab, { harness: id, mode, control, narrative: String(d.narrative || '').slice(0, 20000) });
    } catch (e) {
      log.warn('send to AI failed', { harness: id, message: e.message });
      return { ok: false, message: e.message };
    }
  }

  // ------------------------------------------------------------------------------- sending
  /**
   * @param {import('../tab.js').Tab} tab
   * @param {{harness: string, mode: 'url'|'snapshot', control: boolean, narrative: string}} o
   */
  async send(tab, { harness, mode, control, narrative }) {
    const h = HARNESSES[harness];
    const page = { title: tab.title || tab.wc.getTitle(), url: tab.wc.getURL() };
    const local = harness !== 'claude'; // Claude chat cannot read files on this computer
    const needDir = harness === 'vision' || (local && mode === 'snapshot');
    const dir = needDir ? this.newDir(page.url) : null;
    let snapshot = null;
    let imageOnClipboard = false;
    if (mode === 'snapshot') {
      if (dir) snapshot = await this.snapshot(tab, dir);
      else {
        const img = await tab.wc.capturePage();
        if (!img.isEmpty()) {
          clipboard.writeImage(img);
          imageOnClipboard = true;
        }
      }
    }
    let grant = null;
    if (control && this.b.agent) {
      if (!this.b.agent.grantControl(tab, h.name, h.clients)) throw new Error('This page cannot be controlled by an AI app.');
      const cli = this.b.agent.cliPath();
      grant = { tabId: tab.id, client: h.cliClient, cli: local && existsSync(cli) ? cli : '', mcp: harness !== 'openclaw' };
    }
    const prompt = handoffPrompt({ narrative, page, snapshot, control: grant, imageOnClipboard, local });
    if (dir) {
      writeFileSync(path.join(dir, 'request.md'), `${prompt}\n`);
      writeFileSync(path.join(dir, 'request.json'), `${JSON.stringify({ app: 'Ludworks Browser', version: app.getVersion(), created: new Date().toISOString(), harness, narrative, page, mode, snapshot, control: grant, prompt }, null, 2)}\n`);
    }
    const done = (message) => ({ ok: true, message, dir });
    switch (harness) {
      case 'openclaw':
        await this.toOpenClaw(prompt);
        return done(`Sent to OpenClaw${control ? ' — it may control this page' : ''}.`);
      case 'vision': {
        const exe = this.visionPath();
        if (!exe) throw new Error('Vision is not installed on this computer.');
        clipboard.writeText(prompt);
        const { file, args } = visionLaunch(exe, dir, path.join(dir, 'request.json'));
        await launch(file, args);
        return done('Vision opened the page folder. The prompt is on the clipboard (and in request.md): paste it into the chat.');
      }
      case 'claude':
      case 'claude-code': {
        await shell.openExternal(claudeLink(harness, prompt, harness === 'claude-code' && dir ? dir : ''));
        const extra = imageOnClipboard ? ' Paste the screenshot from the clipboard, then send.' : ' Check the prompt and send it.';
        return done(`Opened ${h.name} with the prompt filled in.${extra}`);
      }
      default:
        throw new Error('Unknown app.');
    }
  }

  newDir(url) {
    mkdirSync(this.root, { recursive: true });
    let dir = path.join(this.root, handoffDirName(new Date(), url));
    for (let i = 2; existsSync(dir); i++) dir = path.join(this.root, `${handoffDirName(new Date(), url)} (${i})`);
    mkdirSync(dir);
    return dir;
  }

  /** screenshot.png, page.html + page_files/ (HTML with its CSS, JS and images), page.txt. */
  async snapshot(tab, dir) {
    const out = { dir };
    try {
      const img = await tab.wc.capturePage();
      if (!img.isEmpty()) {
        out.screenshot = path.join(dir, 'screenshot.png');
        writeFileSync(out.screenshot, img.toPNG());
      }
    } catch (e) {
      log.warn('snapshot screenshot failed', { message: e.message });
    }
    const html = path.join(dir, 'page.html');
    try {
      await tab.wc.savePage(html, 'HTMLComplete');
      out.html = html;
      if (existsSync(path.join(dir, 'page_files'))) out.assets = path.join(dir, 'page_files');
    } catch (e) {
      log.info('savePage failed, keeping the DOM only', { message: e.message });
      try {
        writeFileSync(html, String(await tab.wc.executeJavaScript('document.documentElement.outerHTML', true)));
        out.html = html;
      } catch {
        /* a page without a DOM (PDF viewer, crashed) */
      }
    }
    try {
      const text = await tab.wc.executeJavaScript('document.body ? document.body.innerText : ""', true);
      if (text) {
        out.text = path.join(dir, 'page.txt');
        writeFileSync(out.text, String(text).slice(0, 2 * 1024 * 1024));
      }
    } catch {
      /* no text */
    }
    return out;
  }

  // -------------------------------------------------------------------------------- the apps
  openclawConfigText() {
    try {
      return readFileSync(path.join(process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw'), 'openclaw.json'), 'utf8');
    } catch {
      return '';
    }
  }

  openclaw() {
    const cfg = openclawHookConfig(this.openclawConfigText(), { baseUrl: this.b.prefs.get('openclawUrl') });
    const token = this.b.db.getMeta('openclaw_token', '') || cfg.token;
    return { ...cfg, token, fromConfig: !this.b.db.getMeta('openclaw_token', '') && !!cfg.token };
  }

  async toOpenClaw(message) {
    const c = this.openclaw();
    if (!c.token) throw new Error('OpenClaw needs its hook token: set hooks.enabled and hooks.token in ~/.openclaw/openclaw.json, or enter the token in Settings → AI agents.');
    const req = openclawRequest({ url: c.url, token: c.token, message, idempotencyKey: randomUUID() });
    let res;
    try {
      res = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: AbortSignal.timeout(20000) });
    } catch (e) {
      throw new Error(`Could not reach OpenClaw at ${new URL(c.url).host} — is its gateway running? (${e.cause ? e.cause.code || e.cause.message : e.message})`);
    }
    if (!res.ok) throw new Error(openclawError(res.status, await res.text().catch(() => '')));
  }

  visionPath() {
    return visionCandidates({ home: os.homedir() }).find((p) => existsSync(p)) || null;
  }

  /** Whether an app can be reached now: {ready, note}. */
  readiness(id) {
    if (id === 'vision') return this.visionPath() ? { ready: true, note: 'Opens the page in Vision' } : { ready: false, note: 'Vision is not installed' };
    if (id === 'openclaw') return this.openclaw().token ? { ready: true, note: 'Starts an OpenClaw agent turn' } : { ready: false, note: 'Needs the OpenClaw hook token (Settings)' };
    if (id === 'claude-code') return { ready: true, note: 'A Claude Code session in the page folder' };
    return { ready: true, note: 'A new chat in the Claude app' };
  }

  /** Handoff folders older than a week go away (they are copies of pages, for the AI app to read). */
  prune() {
    let names = [];
    try {
      names = readdirSync(this.root);
    } catch {
      return;
    }
    const now = Date.now();
    for (const n of names) {
      const p = path.join(this.root, n);
      try {
        if (now - statSync(p).mtimeMs > KEEP_HANDOFFS) rmSync(p, { recursive: true, force: true });
      } catch {
        /* in use */
      }
    }
  }

  // --------------------------------------------------------------------- settings / welcome
  async pageCommand(_tab, cmd, a) {
    switch (cmd) {
      case 'send.state': {
        const oc = this.openclaw();
        return {
          sendTo: { ...this.b.prefs.get('sendTo') },
          vision: { found: !!this.visionPath() },
          openclaw: { url: this.b.prefs.get('openclawUrl') || '', hookUrl: oc.url, hasToken: !!oc.token, fromConfig: oc.fromConfig, configured: !!this.openclawConfigText(), enabled: oc.enabled },
          folder: this.root,
        };
      }
      case 'send.set': {
        const patch = {};
        if (a.sendTo && typeof a.sendTo === 'object') patch.sendTo = { ...this.b.prefs.get('sendTo'), ...Object.fromEntries(Object.entries(a.sendTo).filter(([k, v]) => ['vision', 'openclaw', 'claude'].includes(k) && typeof v === 'boolean')) };
        if (typeof a.openclawUrl === 'string') patch.openclawUrl = a.openclawUrl.trim();
        if (Object.keys(patch).length) this.b.prefs.update(patch);
        if (typeof a.openclawToken === 'string') this.b.db.setMeta('openclaw_token', a.openclawToken.trim().slice(0, 500));
        return { ok: true };
      }
      case 'send.test-openclaw':
        try {
          await this.toOpenClaw('Ludworks Browser is connected: this is a test message from its "Send to AI" button. No action is needed.');
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      case 'send.open-folder':
        mkdirSync(this.root, { recursive: true });
        await shell.openPath(this.root);
        return { ok: true };
      default:
        throw new Error('not allowed');
    }
  }
}

function launch(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
