// AI agents (Browser.registerFeature): lets coding agents and harnesses — Claude Code and other MCP
// clients, Vision through its plugins, scripts — use the browser through the agent server (server.js)
// and the lwb CLI that ships next to the browser.
//
// Off until the user turns it on (Settings → AI agents, or by allowing the first agent that asks). Each
// client is approved once by the user. An agent works in a window of its own — framed and labelled with
// its name, kept out of session restore, history and tab sync — and can use other tabs only when the user
// shares them (or allows all tabs). It never sees ludworks:// pages, private windows or the vault; saved
// passwords are filled by the browser itself (browser_fill_login), after the user says yes.

import { app, clipboard, Notification, screen, webContents as allWebContents } from 'electron';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer, HttpError, newToken, writeEndpoint, removeEndpoint, DEFAULT_PORT, ENDPOINT_FILE } from './server.js';
import { handleMessage, initializeClientName } from './mcp.js';
import { catalog, canonicalToolName } from './tools.js';
import { AgentTab, AgentError, sleep } from './driver.js';
import { Runner, errorLine, dialogLine } from './runner.js';
import { visionPaths, visionShell, visionManifest, skillMarkdown, claudeAddArgs, mcpStdioConfig, mcpHttpConfig, allowInClaudeSettings, claudeDesktopConfigPaths, addMcpServer, VISION_PLUGIN_FILE, SERVER_NAME } from './integrations.js';
import { hostOf, originOf, fixupInput } from '../util/urls.js';
import { log } from '../util/log.js';

const APPROVAL_TIMEOUT = 3 * 60 * 1000;
const DENY_COOLDOWN = 10 * 60 * 1000;
const IDLE_SESSION = 60 * 60 * 1000;
const KNOWN_CLIENTS = { 'claude-code': 'Claude Code', 'claude-ai': 'Claude', vision: 'Vision', openclaw: 'OpenClaw', 'cursor-vscode': 'Cursor', cursor: 'Cursor', codex: 'Codex', 'codex-mcp-client': 'Codex', 'gemini-cli-mcp-client': 'Gemini CLI', windsurf: 'Windsurf', lwb: 'lwb' };
const BLOCKED_SCHEMES = /^(ludworks|lwshell|chrome|devtools|chrome-extension|chrome-untrusted|javascript|vbscript|view-source):/i;

/** A display name for a client id ("claude-code" → "Claude Code"). */
export function clientDisplayName(name) {
  const n = String(name || '').trim();
  if (!n) return 'Agent';
  return KNOWN_CLIENTS[n.toLowerCase()] || n.slice(0, 60);
}

class AgentSession {
  constructor({ key, client, label }) {
    this.key = key;
    this.client = client;
    this.label = label || '';
    this.created = Date.now();
    this.lastUsed = Date.now();
    this.tabs = new Set(); // tab ids it opened
    this.shared = new Set(); // tab ids the user shared with it
    this.current = null;
    this.window = null; // its WindowCtl
    this.queue = Promise.resolve();
    this.busy = 0;
    this.stopped = false;
    this.inflight = new Map(); // request id → AbortController
    this.events = new EventEmitter();
    this.downloads = [];
    this.seen = { console: new Map(), network: new Map() };
    this.calls = 0;
    this.lastTool = '';
  }

  info() {
    return { client: this.client, label: this.label, key: this.key, busy: this.busy > 0, stopped: this.stopped };
  }
}

export class AgentHub {
  /** @param {import('../browser.js').Browser} browser */
  constructor(browser) {
    this.name = 'agent';
    this.browser = browser;
    this.popups = ['agents'];
    this.pagePrefix = 'agent.';
    this.pages = ['settings'];
    this.server = null;
    this.port = 0;
    this.sessions = new Map(); // key → AgentSession
    this.mcpSessions = new Map(); // Mcp-Session-Id → {client}
    this.drivers = new Map(); // tab id → AgentTab
    this.byWc = new Map(); // webContents id → AgentTab
    this.owners = new Map(); // tab id → AgentSession (opened by it, or shared with it)
    this.grants = new Map(); // tab id → {name, clients: Set} — "let it control this page" (send.js): shared when that client connects
    this.pendingApprovals = new Map(); // client → Promise<boolean>
    this.allowedOnce = new Set();
    this.denied = new Map(); // client → until (ms)
    this.runner = new Runner(this);
    browser.prefs.on('change', (keys) => {
      if (keys.includes('agentAccess')) this.applyAccess();
      if (keys.some((k) => k.startsWith('agent'))) this.notifyPages();
    });
    browser.downloads.silentFor = (wc) => !!(wc && this.tabOwner(this.browser.tabForWebContents(wc)));
    this.applyAccess();
    setInterval(() => this.sweep(), 5 * 60 * 1000).unref();
    // New tabs, from Electron itself: every tab is a web contents, created before its tab is placed.
    this.watched = new WeakSet();
    app.on('web-contents-created', (_e, wc) => this.onWebContents(wc));
  }

  // -------------------------------------------------------------------------------- server
  get on() {
    return !!this.browser.prefs.get('agentAccess');
  }

  token() {
    let t = this.browser.db.getMeta('agent_token', null);
    if (typeof t !== 'string' || t.length !== 64) {
      t = newToken();
      this.browser.db.setMeta('agent_token', t);
    }
    return t;
  }

  applyAccess() {
    if (this.on && !this.server) this.start().catch((e) => log.warn('agent server failed to start', { message: e.message }));
    else if (!this.on && this.server) this.stop();
  }

  async start() {
    const server = new AgentServer({ token: this.token(), log, handler: this.handler() });
    this.server = server;
    const preferred = Number(this.browser.db.getMeta('agent_port', DEFAULT_PORT)) || DEFAULT_PORT;
    this.port = await server.listen(preferred);
    if (this.server !== server) {
      server.close();
      return;
    }
    writeEndpoint(this.browser.profileDir, { port: this.port, token: server.token, pid: process.pid, app: app.getVersion(), started: new Date().toISOString() });
    log.info('agent server listening', { port: this.port });
    this.refresh();
  }

  stop() {
    const server = this.server;
    this.server = null;
    if (server) server.close().catch(() => {});
    removeEndpoint(this.browser.profileDir, this.port);
    for (const s of [...this.sessions.values()]) this.endSession(s, 'Agent access was turned off.');
    this.mcpSessions.clear();
    this.refresh();
  }

  beforeQuit() {
    if (this.server) removeEndpoint(this.browser.profileDir, this.port);
  }

  handler() {
    return {
      status: () => ({ ok: true, app: app.getVersion(), access: this.on, sessions: this.sessions.size }),
      catalog: () => catalog(app.getVersion()),
      call: async (id, tool, args, signal) => {
        const name = canonicalToolName(tool);
        if (!name) throw new HttpError(404, `Unknown tool ${tool}. Run "lwb tools" for the list.`);
        const s = this.session({ client: id.client || 'lwb', key: id.session || `${id.client || 'lwb'}:default`, label: id.label });
        await this.ensureApproved(s.client);
        return this.callTool(s, name, args, signal, randomUUID());
      },
      mcp: (id, message, signal) => this.mcp(id, message, signal),
      endSession: (id) => {
        const key = id.session ? this.sessionKey(id.client, id.session) : id.mcpSession ? this.sessionKey((this.mcpSessions.get(id.mcpSession) || {}).client, id.mcpSession) : null;
        const s = key && this.sessions.get(key);
        if (s) this.endSession(s, null);
        if (id.mcpSession) this.mcpSessions.delete(id.mcpSession);
      },
    };
  }

  sessionKey(client, session) {
    return `${clientDisplayName(client)}|${session}`;
  }

  session({ client, key, label }) {
    const name = clientDisplayName(client);
    const k = `${name}|${key}`;
    let s = this.sessions.get(k);
    if (!s) {
      s = new AgentSession({ key: k, client: name, label });
      this.sessions.set(k, s);
      for (const [id, g] of this.grants) {
        const t = this.findTab(id);
        if (t && g.clients.has(name)) {
          this.share(s, t);
          s.current = t.id;
        }
      }
      this.refresh();
    } else if (label && !s.label) s.label = label;
    return s;
  }

  // ------------------------------------------------------------------- control of a user's page
  /**
   * The user sent a page to an AI app and let it control the page (send.js): `clients` (display names, as
   * agents connect with them) may use that tab without asking — right away when connected, else once one
   * connects. The page shows that it is controlled (controlOf) until the user stops it.
   */
  grantControl(tab, name, clients) {
    if (!tab || tab.private || tab.ctl.agent) return false;
    if (!this.on) this.browser.prefs.update({ agentAccess: true });
    for (const c of clients) {
      this.allowedOnce.add(c);
      this.denied.delete(c);
    }
    this.grants.set(tab.id, { name, clients: new Set(clients) });
    const live = [...this.sessions.values()].filter((s) => clients.includes(s.client)).sort((a, b) => b.lastUsed - a.lastUsed);
    if (live.length) {
      this.share(live[0], tab);
      live[0].current = tab.id;
    }
    this.refresh(live[0] || null);
    tab.update();
    return true;
  }

  /** The user took the page back: no agent controls it any more, none may take it over later. */
  revokeControl(tab) {
    this.grants.delete(tab.id);
    const owner = this.owners.get(tab.id);
    if (owner && owner.shared.has(tab.id)) {
      owner.shared.delete(tab.id);
      this.owners.delete(tab.id);
      if (owner.current === tab.id) owner.current = null;
      this.release(tab);
      this.refresh(owner);
    } else tab.update();
    this.browser.refreshToolbar();
  }

  /** Who controls this user's tab: {client, busy, waiting} (waiting: allowed, not connected yet), or null. */
  controlOf(tab) {
    if (!tab || tab.ctl.agent) return null;
    const owner = this.owners.get(tab.id);
    if (owner && owner.shared.has(tab.id) && this.sessions.has(owner.key)) return { client: owner.client, busy: owner.busy > 0 && !owner.stopped, stopped: owner.stopped, waiting: false };
    const g = this.grants.get(tab.id);
    return g ? { client: g.name, busy: false, stopped: false, waiting: true } : null;
  }

  async mcp(id, message, signal) {
    const initName = initializeClientName(message);
    let client = id.client || initName || '';
    let key;
    let sessionId;
    if (id.session) key = id.session; // the lwb bridge: one session per bridge process
    else if (initName) {
      sessionId = randomUUID();
      this.mcpSessions.set(sessionId, { client: initName });
      key = sessionId;
    } else if (id.mcpSession && this.mcpSessions.has(id.mcpSession)) {
      client = this.mcpSessions.get(id.mcpSession).client;
      key = id.mcpSession;
    } else key = 'default';
    if (!client) client = 'MCP client';
    const label = id.label || '';
    const ctx = {
      catalog: () => catalog(app.getVersion()),
      hasTool: (n) => !!canonicalToolName(n),
      callTool: async (name, args, { signal: sig, requestId }) => {
        const s = this.session({ client, key, label });
        try {
          await this.ensureApproved(s.client);
        } catch (e) {
          if (e instanceof HttpError) return { content: [{ type: 'text', text: e.message }], isError: true };
          throw e;
        }
        return this.callTool(s, canonicalToolName(name), args, sig, requestId);
      },
      cancel: (requestId) => {
        const s = this.sessions.get(`${clientDisplayName(client)}|${key}`);
        const ac = s && s.inflight.get(requestId);
        if (ac) ac.abort();
      },
      signal,
    };
    const response = await handleMessage(message, ctx);
    return { response, sessionId };
  }

  /** Runs one tool call in the session's queue (one action at a time per agent). */
  callTool(s, name, args, signal, requestId) {
    const ac = new AbortController();
    if (signal) {
      if (signal.aborted) ac.abort();
      else signal.addEventListener('abort', () => ac.abort(), { once: true });
    }
    s.inflight.set(requestId, ac);
    const run = async () => {
      if (ac.signal.aborted) return { content: [{ type: 'text', text: 'Cancelled.' }], isError: true };
      if (!this.server) return { content: [{ type: 'text', text: 'Agent access was turned off in Ludworks Browser.' }], isError: true };
      if (s.stopped) return { content: [{ type: 'text', text: `The user stopped ${s.client} from using the browser for now. Ask the user before trying again (they can press Resume in the AI agents menu of the browser).` }], isError: true };
      s.busy++;
      s.calls++;
      s.lastTool = name;
      s.lastUsed = Date.now();
      this.refresh(s);
      try {
        return await this.runner.run(s, name, args, ac.signal);
      } finally {
        s.busy--;
        s.lastUsed = Date.now();
        this.refresh(s);
      }
    };
    const p = s.queue.then(run, run);
    s.queue = p.catch(() => {});
    return p.finally(() => s.inflight.delete(requestId));
  }

  endSession(s, reason) {
    for (const ac of s.inflight.values()) ac.abort();
    this.sessions.delete(s.key);
    for (const id of [...s.tabs, ...s.shared]) {
      if (this.owners.get(id) === s) this.owners.delete(id);
      const t = this.findTab(id);
      if (t) this.release(t);
    }
    if (s.window && !s.window.destroyed) {
      s.window.agent = null;
      s.window.sendState();
    }
    s.window = null;
    if (reason) log.info('agent session ended', { client: s.client });
    this.refresh();
  }

  /** Forget sessions idle for an hour (their window stays, as a normal window). */
  sweep() {
    const now = Date.now();
    for (const s of [...this.sessions.values()]) if (!s.busy && now - s.lastUsed > IDLE_SESSION) this.endSession(s, 'idle');
    for (const [c, until] of this.denied) if (until < now) this.denied.delete(c);
  }

  // ----------------------------------------------------------------------------- approvals
  clients() {
    const c = this.browser.db.getMeta('agent_clients', {}) || {};
    return c && typeof c === 'object' ? c : {};
  }

  approve(client, always) {
    if (always) this.browser.db.setMeta('agent_clients', { ...this.clients(), [client]: { added: Date.now() } });
    else this.allowedOnce.add(client);
    this.denied.delete(client);
    this.notifyPages();
  }

  isApproved(client) {
    return Object.hasOwn(this.clients(), client) || this.allowedOnce.has(client);
  }

  async ensureApproved(client) {
    if (this.isApproved(client)) return;
    const until = this.denied.get(client);
    if (until && until > Date.now()) throw new HttpError(403, `The user did not allow ${client} to use Ludworks Browser. Ask the user to allow it (Ludworks Browser → Settings → AI agents).`, 'denied');
    let p = this.pendingApprovals.get(client);
    if (!p) {
      p = this.askApproval(client, { kind: 'connect' }).finally(() => this.pendingApprovals.delete(client));
      this.pendingApprovals.set(client, p);
    }
    const decision = await p;
    if (decision === 'always' || decision === 'once') return;
    if (decision === 'deny') this.denied.set(client, Date.now() + DENY_COOLDOWN);
    throw new HttpError(403, decision === 'timeout' ? `Nobody answered the browser's question whether ${client} may use it. Ask the user to look at Ludworks Browser.` : `The user did not allow ${client} to use Ludworks Browser.`, 'denied');
  }

  /** Shows a modal question in a normal window. Resolves 'always' | 'once' | 'deny' | 'timeout' (or the answer object). */
  async askApproval(client, data, { ctl = null, raw = false } = {}) {
    let w = ctl && !ctl.destroyed ? ctl : this.browser.focusedWindow({ allowPrivate: false, allowAgent: false });
    if (!w) w = this.browser.newWindow({});
    if (w.win.isMinimized()) w.win.restore();
    if (!w.win.isFocused()) w.win.flashFrame(true);
    let note = null;
    try {
      if (Notification.isSupported() && !w.win.isFocused()) {
        note = new Notification({ title: `${client} wants to use Ludworks Browser`, body: data.kind === 'login' ? `Sign in to ${data.host} with your saved password` : 'Click to answer' });
        note.on('click', () => w.win.focus());
        note.show();
      }
    } catch {
      note = null;
    }
    const answer = await Promise.race([w.ask('agent-approve', { client, ...data }), sleep(APPROVAL_TIMEOUT).then(() => 'timeout')]);
    if (answer === 'timeout' && w.popup && w.popup.kind === 'agent-approve') w.hidePopup('agent-approve');
    try {
      if (!w.win.isDestroyed()) w.win.flashFrame(false);
      if (note) note.close();
    } catch {
      /* window gone */
    }
    if (raw) return answer;
    const decision = answer === 'timeout' ? 'timeout' : answer && answer.decision;
    if (data.kind === 'connect' && (decision === 'always' || decision === 'once')) {
      if (!this.on) this.browser.prefs.update({ agentAccess: true });
      this.approve(client, decision === 'always');
    }
    return decision || 'deny';
  }

  /** `--agent-request=<client>`: the lwb CLI started (or found) the browser while agent access is off. */
  async request(clientName) {
    const client = clientDisplayName(clientName);
    if (this.on && this.isApproved(client)) return;
    if (this.pendingApprovals.has(client)) return;
    const p = this.askApproval(client, { kind: 'connect', turnOn: !this.on }).finally(() => this.pendingApprovals.delete(client));
    this.pendingApprovals.set(client, p);
    const d = await p;
    if (d === 'deny') this.denied.set(client, Date.now() + DENY_COOLDOWN);
  }

  // ------------------------------------------------------------------------------ tabs/windows
  findTab(id) {
    for (const w of this.browser.windows) {
      const t = w.tabById(Number(id));
      if (t && !t.destroyed && !t.wc.isDestroyed()) return t;
    }
    return null;
  }

  tabOwner(tab) {
    return tab ? this.owners.get(tab.id) || null : null;
  }

  /** The tab a call works on: the given id (owned, shared, or any normal tab when the user allows all) or the current one. */
  tabFor(s, tabId, { create = false } = {}) {
    if (tabId !== undefined && tabId !== null) {
      const t = this.findTab(tabId);
      if (!t) throw new AgentError(`There is no tab ${tabId}. List yours with browser_tabs.`);
      this.checkTabAccess(s, t);
      return t;
    }
    let t = s.current !== null ? this.findTab(s.current) : null;
    if (t && this.owners.get(t.id) !== s) t = null;
    if (!t) {
      const mine = [...s.tabs, ...s.shared].map((id) => this.findTab(id)).filter(Boolean);
      t = mine[mine.length - 1] || null;
      if (t) s.current = t.id;
    }
    if (t) return t;
    if (!create) throw new AgentError('You have no tab yet. Open a page with browser_navigate (or browser_tabs action=new).');
    return this.openTabSync(s, 'about:blank');
  }

  checkTabAccess(s, t) {
    if (t.private) throw new AgentError('That tab is in a private window: agents never see private windows.');
    if (/^ludworks:/i.test(t.wc.getURL())) throw new AgentError("That is one of the browser's own pages (settings, passwords…): agents cannot use them.");
    const owner = this.owners.get(t.id);
    if (owner === s) return;
    if (owner && owner !== s) throw new AgentError(`Tab ${t.id} is being used by ${owner.client}.`);
    if (t.ctl.agent) throw new AgentError(`Tab ${t.id} belongs to another agent.`);
    if (this.browser.prefs.get('agentScope') === 'all') {
      this.share(s, t);
      return;
    }
    throw new AgentError(`Tab ${t.id} is one of the user's tabs. Ask the user to share it with you (browser_tabs action=share asks for the tab they are looking at).`);
  }

  share(s, t) {
    s.shared.add(t.id);
    this.owners.set(t.id, s);
    t.agentOwned = true;
    this.driverFor(t);
    t.update();
  }

  /** Stops agent control of a tab (it stays open). */
  release(t) {
    const at = this.drivers.get(t.id);
    if (at) {
      at.dispose();
      this.drivers.delete(t.id);
      this.byWc.delete(t.wc.id);
    }
    t.agentOwned = false;
    try {
      if (!t.wc.isDestroyed()) t.wc.setBackgroundThrottling(true);
    } catch {
      /* gone */
    }
    t.update();
  }

  agentWindow(s) {
    if (s.window && !s.window.destroyed) return s.window;
    const near = this.browser.focusedWindow({ allowPrivate: false, allowAgent: false });
    let bounds = null;
    if (near) {
      // next to the user's window, a 1280-wide page where the screen allows it
      const b = near.win.getBounds();
      const wa = screen.getDisplayMatching(b).workArea;
      const width = Math.min(1280, wa.width - 32);
      const height = Math.min(920, wa.height - 32);
      bounds = { x: Math.max(wa.x, Math.min(b.x + 48, wa.x + wa.width - width)), y: Math.max(wa.y, Math.min(b.y + 48, wa.y + wa.height - height)), width, height };
    }
    const ctl = this.browser.newWindow({ empty: true, bounds, agent: s.info() });
    s.window = ctl;
    return ctl;
  }

  openTabSync(s, url) {
    const ctl = this.agentWindow(s);
    const t = ctl.newTab({ url, active: true });
    this.adopt(s, t);
    s.current = t.id;
    return t;
  }

  async openTab(s, url) {
    return this.openTabSync(s, url);
  }

  adopt(s, t) {
    s.tabs.add(t.id);
    this.owners.set(t.id, s);
    t.agentOwned = true;
    if (t.ctl.agent) t.view.setBounds(t.ctl.contentRect());
    try {
      t.wc.setBackgroundThrottling(false); // keep rendering while the window is behind others or minimised
    } catch {
      /* gone */
    }
  }

  driverFor(tab) {
    let at = this.drivers.get(tab.id);
    if (!at) {
      at = new AgentTab(tab);
      this.drivers.set(tab.id, at);
      this.byWc.set(tab.wc.id, at);
      try {
        tab.wc.setBackgroundThrottling(false);
      } catch {
        /* gone */
      }
    }
    // a tab that is not the active one of its window has a stale (or no) size: give it the window's
    if (tab.ctl.activeId !== tab.id && !tab.ctl.destroyed) tab.view.setBounds(tab.ctl.contentRect());
    if (tab.ctl.agent && tab.ctl.activeId !== tab.id) tab.ctl.activate(tab.id);
    return at;
  }

  /** Every new web contents: once its tab is placed in a window, watchTab sees it. The browser's own views
   *  (tab strip, popups, panels) never become tabs and are given up on after a few tries. */
  onWebContents(wc, tries = 0) {
    const later = tries ? (fn) => setTimeout(fn, 50) : setImmediate;
    later(() => {
      if (wc.isDestroyed() || this.watched.has(wc)) return;
      const tab = this.browser.tabForWebContents(wc);
      if (!tab) {
        if (tries < 8) this.onWebContents(wc, tries + 1);
        return;
      }
      this.watched.add(wc);
      this.watchTab(tab);
    });
  }

  /** A new tab. Tabs opened from an agent's tab (links, window.open, sign-in popups) are the agent's too. */
  watchTab(tab) {
    const wc = tab.wc;
    const id = tab.id;
    wc.once('destroyed', () => this.onTabGone(id, wc.id));
    let opener = tab.openerId ? this.findTab(tab.openerId) : null;
    if (!opener) {
      try {
        const f = wc.opener;
        const owc = f ? allWebContents.fromFrame(f) : null;
        opener = owc ? this.browser.tabForWebContents(owc) : null;
      } catch {
        opener = null;
      }
    }
    const s = opener ? this.owners.get(opener.id) : null;
    if (!s || !this.sessions.has(s.key) || tab.destroyed || wc.isDestroyed()) return;
    this.adopt(s, tab);
    if (!tab.ctl.agent && tab.ctl.tabs.length === 1) {
      // a popup window (sign-in with…, payment): mark it as the agent's
      tab.ctl.agent = s.info();
      tab.ctl.sendState();
    }
    const front = tab.ctl.activeId === tab.id;
    if (front && opener.id === s.current) s.current = tab.id;
    s.events.emit('tab-opened', tab);
  }

  onTabGone(id, wcId) {
    this.grants.delete(id);
    const at = this.drivers.get(id);
    if (at) at.dispose();
    this.drivers.delete(id);
    this.byWc.delete(wcId);
    const s = this.owners.get(id);
    this.owners.delete(id);
    if (s) {
      s.tabs.delete(id);
      s.shared.delete(id);
      if (s.current === id) s.current = null;
    }
  }

  /** Feature hook: network log of agent tabs, and their downloads. */
  attachSession(ses, hub) {
    hub.onBeforeRequest((d) => {
      const at = this.byWc.get(d.webContentsId);
      if (at) at.netStart(d);
      return null;
    });
    hub.onCompleted((d) => {
      const at = this.byWc.get(d.webContentsId);
      if (at) at.netEnd(d, false);
    });
    hub.onErrorOccurred((d) => {
      const at = this.byWc.get(d.webContentsId);
      if (at) at.netEnd(d, true);
    });
    ses.on('will-download', (_e, item, wc) => {
      const tab = wc ? this.browser.tabForWebContents(wc) : null;
      const s = this.tabOwner(tab);
      if (!s) return;
      const rec = { filename: path.basename(item.getSavePath() || item.getFilename()), path: item.getSavePath(), url: item.getURL(), state: 'downloading', received: 0, total: item.getTotalBytes() };
      s.downloads.push(rec);
      if (s.downloads.length > 100) s.downloads.shift();
      item.on('updated', () => {
        rec.received = item.getReceivedBytes();
        rec.path = item.getSavePath() || rec.path;
        rec.filename = path.basename(rec.path || rec.filename);
      });
      item.once('done', (_ev, state) => {
        rec.state = state === 'completed' ? 'done' : state;
        rec.received = item.getReceivedBytes();
      });
      s.events.emit('download', rec);
    });
  }

  downloadsFor(s) {
    return s.downloads.slice(-50);
  }

  checkUrl(url) {
    if (BLOCKED_SCHEMES.test(url)) throw new AgentError("Agents cannot open the browser's internal pages or script URLs.");
  }

  pageLine(tab, { loading = true } = {}) {
    const wc = tab.wc;
    const title = tab.title || wc.getTitle() || '';
    return `Tab ${tab.id}${title ? ` — "${title}"` : ''} — ${wc.getURL() || 'about:blank'}${loading && wc.isLoading() ? ' (loading)' : ''}`;
  }

  scriptsAllowed() {
    return this.browser.prefs.get('agentScripts') !== false;
  }

  // ------------------------------------------------------------------------- waiting/observing
  waitStop(wc, ms) {
    return new Promise((resolve) => {
      if (wc.isDestroyed() || !wc.isLoading()) return resolve(false);
      const done = (timedOut) => {
        clearTimeout(timer);
        if (!wc.isDestroyed()) wc.off('did-stop-loading', onStop);
        resolve(timedOut);
      };
      const onStop = () => done(false);
      const timer = setTimeout(() => done(true), ms);
      wc.on('did-stop-loading', onStop);
    });
  }

  /** Resolves when a navigation started now has loaded (or failed, or timed out). Has cancel(). */
  waitForLoad(tab, wait, ms) {
    const wc = tab.wc;
    const at = this.drivers.get(tab.id);
    const t0 = Date.now();
    let finish;
    let started = false;
    const p = new Promise((resolve) => {
      let timer = null;
      const cleanup = () => {
        clearTimeout(timer);
        if (wc.isDestroyed()) return;
        wc.off('did-finish-load', onLoad);
        wc.off('dom-ready', onDom);
        wc.off('did-fail-load', onFail);
        wc.off('did-start-navigation', onStart);
        wc.off('did-stop-loading', onStop);
        wc.off('did-navigate-in-page', onInPage);
      };
      finish = (timedOut) => {
        if (!finish) return;
        finish = null;
        cleanup();
        resolve({ timedOut, ms: Date.now() - t0 });
      };
      const idle = async () => {
        const end = Date.now() + 10000;
        while (at && Date.now() < end && !(at.inflight.size === 0 && Date.now() - at.lastNet >= 500)) await sleep(100);
      };
      const onLoad = () => {
        if (wait === 'networkidle') idle().then(() => finish && finish(false));
        else if (finish) finish(false);
      };
      const onDom = () => wait === 'domcontentloaded' && finish && finish(false);
      const onFail = (_e, code, _d, _u, isMain) => isMain !== false && code !== -3 && finish && finish(false);
      const onStart = (d) => {
        if (d && d.isMainFrame && !d.isSameDocument) started = true;
      };
      const onStop = () => started && setTimeout(() => finish && (wait === 'networkidle' ? onLoad() : finish(false)), 50);
      const onInPage = (_e, _url, isMain) => isMain && finish && finish(false);
      wc.on('did-finish-load', onLoad);
      wc.on('dom-ready', onDom);
      wc.on('did-fail-load', onFail);
      wc.on('did-start-navigation', onStart);
      wc.on('did-stop-loading', onStop);
      wc.on('did-navigate-in-page', onInPage);
      timer = setTimeout(() => finish && finish(true), wait === 'none' ? 300 : ms);
    });
    p.cancel = () => finish && finish(false);
    return p;
  }

  /** Watches what an action does to a tab: navigation, new tabs, dialogs, downloads. finish() → report lines. */
  observe(s, tab) {
    const wc = tab.wc;
    const at = this.drivers.get(tab.id);
    const startUrl = wc.getURL();
    let navigated = false;
    const opened = [];
    const downloads = [];
    const onNav = (d) => {
      if (d && d.isMainFrame && !d.isSameDocument) navigated = true;
    };
    const onOpen = (t) => opened.push(t);
    const onDl = (d) => downloads.push(d);
    wc.on('did-start-navigation', onNav);
    s.events.on('tab-opened', onOpen);
    s.events.on('download', onDl);
    return {
      finish: async ({ settleMs = 250, navTimeoutMs = 20000 } = {}) => {
        await sleep(120);
        if (!wc.isDestroyed() && (navigated || wc.isLoading()) && !(at && at.dialog)) await this.waitStop(wc, navTimeoutMs);
        await sleep(settleMs);
        if (opened.length) await sleep(200); // let new tabs start loading
        if (!wc.isDestroyed()) wc.off('did-start-navigation', onNav);
        s.events.off('tab-opened', onOpen);
        s.events.off('download', onDl);
        const lines = [];
        if (wc.isDestroyed()) return ['→ The tab closed.'];
        const url = wc.getURL();
        if (url !== startUrl) lines.push(`→ Now at ${url}${tab.title ? ` — "${tab.title}"` : ''}`);
        else if (navigated) lines.push('→ The page reloaded.');
        if (tab.error) lines.push(`→ ${errorLine(tab.error)}`);
        for (const t of opened) if (!t.destroyed) lines.push(`→ Opened tab ${t.id}: ${t.wc.isDestroyed() ? t.url : t.wc.getURL() || t.url}${s.current === t.id ? ' — it is now your current tab.' : ' (in the background; browser_tabs action=select to use it).'}`);
        if (at && at.dialog) lines.push(`→ ${dialogLine(at.dialog)}`);
        for (const d of downloads) lines.push(`→ Download started: ${d.filename}${d.path ? ` → ${d.path}` : ''}`);
        if (lines.length && (url !== startUrl || navigated)) this.refresh(s);
        return lines;
      },
    };
  }

  // ------------------------------------------------------------------------------- tab tool
  async tabsTool(s, a) {
    const action = a.action || 'list';
    const line = (t) => `${t.id === s.current ? '* ' : '  '}${t.id}  ${(t.title || t.wc.getTitle() || 'New tab').slice(0, 90)} — ${t.wc.getURL()}${s.shared.has(t.id) ? ' (shared by the user)' : ''}${t.wc.isLoading() ? ' (loading)' : ''}`;
    const mine = () => [...s.tabs, ...s.shared].map((id) => this.findTab(id)).filter(Boolean);
    const okText = (txt) => ({ content: [{ type: 'text', text: txt }], isError: false });
    switch (action) {
      case 'list': {
        const tabs = mine();
        const lines = tabs.length ? ['Your tabs (* = current):', ...tabs.map(line)] : ['You have no tabs. Open one with browser_navigate or browser_tabs action=new.'];
        if (this.browser.prefs.get('agentScope') === 'all') {
          const others = this.userTabs().filter((t) => !this.owners.has(t.id));
          if (others.length) lines.push('', "The user's tabs (you may use them by id):", ...others.slice(0, 100).map((t) => `  ${t.id}  ${(t.title || '').slice(0, 90)} — ${t.wc.getURL()}`));
        } else {
          const n = this.userTabs().length;
          if (n) lines.push('', `The user has ${n} other tab${n === 1 ? '' : 's'} open. browser_tabs action=share asks them to share the one they are looking at.`);
        }
        return okText(lines.join('\n'));
      }
      case 'new': {
        let url = a.url ? a.url.trim() : 'about:blank';
        if (a.url) {
          const f = fixupInput(url);
          if (!f) throw new AgentError(`"${url}" is not an address.`);
          url = f.type === 'url' ? f.url : this.browser.searchUrlFor(f.query);
          this.checkUrl(url);
        }
        const t = await this.openTab(s, url);
        if (a.url) await this.waitForLoad(t, 'load', 30000);
        return okText(`Opened tab ${t.id} (now your current tab): ${t.wc.getURL() || url}`);
      }
      case 'select': {
        if (a.tab === undefined) throw new AgentError('Give the tab to select.');
        const t = this.tabFor(s, a.tab);
        s.current = t.id;
        if (t.ctl.agent) t.ctl.activate(t.id);
        return okText(`Tab ${t.id} is now your current tab: ${t.wc.getURL()}`);
      }
      case 'close': {
        const t = a.tab !== undefined ? this.tabFor(s, a.tab) : this.tabFor(s);
        if (s.shared.has(t.id)) {
          s.shared.delete(t.id);
          this.owners.delete(t.id);
          this.release(t);
          if (s.current === t.id) s.current = null;
          return okText(`Stopped using tab ${t.id} (it is the user's, so it stays open).`);
        }
        t.ctl.closeTab(t.id);
        return okText(`Closed tab ${t.id}.`);
      }
      case 'close_all': {
        const n = s.tabs.size;
        const shared = s.shared.size;
        for (const id of [...s.tabs]) {
          const t = this.findTab(id);
          if (t) t.ctl.closeTab(t.id);
        }
        for (const id of [...s.shared]) {
          const t = this.findTab(id);
          this.owners.delete(id);
          if (t) this.release(t);
        }
        s.shared.clear();
        s.current = null;
        return okText(`Closed ${n} tab${n === 1 ? '' : 's'}${shared ? ` and gave back ${shared} shared tab${shared === 1 ? '' : 's'}` : ''}.`);
      }
      case 'share': {
        const w = this.browser.focusedWindow({ allowPrivate: false, allowAgent: false });
        const t = w && w.activeTab();
        if (!t || /^ludworks:/i.test(t.wc.getURL())) throw new AgentError("The user isn't looking at a web page that could be shared.");
        if (this.owners.get(t.id) === s) {
          s.current = t.id;
          return okText(`Tab ${t.id} is already yours: ${t.wc.getURL()}`);
        }
        const ans = await this.askApproval(s.client, { kind: 'share', title: t.title || '', host: hostOf(t.wc.getURL()) || t.wc.getURL() }, { ctl: w, raw: true });
        if (!ans || ans === 'timeout' || ans.decision === 'deny') throw new AgentError('The user did not share a tab.');
        this.share(s, t);
        s.current = t.id;
        return okText(`The user shared tab ${t.id} with you (now your current tab): ${this.pageLine(t)}`);
      }
      default:
        throw new AgentError(`Unknown action ${action}.`);
    }
  }

  userTabs() {
    const out = [];
    for (const w of this.browser.windows) {
      if (w.destroyed || w.private || w.agent) continue;
      for (const t of w.tabs) if (!t.destroyed && !t.wc.isDestroyed() && !/^ludworks:/i.test(t.wc.getURL())) out.push(t);
    }
    return out;
  }

  async resize(s, tab, width, height) {
    const ctl = tab.ctl;
    if (!ctl.agent) throw new AgentError("Only your own window can be resized (this tab is in the user's window).");
    if (ctl.win.isMaximized()) ctl.win.unmaximize();
    const [cw, ch] = ctl.win.getContentSize();
    const r = ctl.contentRect();
    ctl.win.setContentSize(Math.round(cw - r.width + width), Math.round(ch - r.height + height));
    await sleep(250);
    const after = ctl.contentRect();
    return { width: after.width, height: after.height };
  }

  // ------------------------------------------------------------------------------- vault login
  async fillLogin(s, tab, { username = '' } = {}) {
    const b = this.browser;
    const policy = b.prefs.get('agentLogins');
    if (policy === 'never') throw new AgentError('The user does not let agents use saved passwords. Ask the user to sign in.');
    const phase = b.account.phase();
    if (phase === 'logged_out') throw new AgentError('Ludworks Browser is not signed in to a Ludworks vault, so there are no saved passwords. Ask the user to sign in on this page.');
    if (phase !== 'unlocked') throw new AgentError('The password vault is locked. Ask the user to unlock it in Ludworks Browser (the key icon in the address bar), then try again.');
    // the frame holding the login form when autofill tracks one (iframes), else the page
    const frame = typeof b.autofill.fillTarget === 'function' ? b.autofill.fillTarget(tab) : tab.wc.mainFrame;
    const url = frame.url;
    const host = hostOf(url) || url;
    let matches = await b.autofill.loginsForUrl(url);
    if (!matches.length) throw new AgentError(`No saved login for ${host}. Ask the user to sign in.`);
    if (username) {
      const m = matches.filter((x) => String(x.data.login.username || '').toLowerCase() === username.toLowerCase());
      if (!m.length) throw new AgentError(`No saved login for ${host} with that username.`);
      matches = m;
    }
    const origin = originOf(url);
    const remembered = (b.db.getMeta('agent_login_sites', {}) || {})[`${s.client}|${origin}`];
    let itemId = matches.length === 1 && (remembered || policy === 'allow') ? matches[0].id : null;
    if (!itemId) {
      const ans = await this.askApproval(s.client, { kind: 'login', host, accounts: matches.slice(0, 20).map((m) => ({ id: m.id, name: String(m.data.name || ''), username: String(m.data.login.username || '') })) }, { ctl: tab.ctl, raw: true });
      if (!ans || ans === 'timeout' || ans.decision === 'deny') throw new AgentError(`The user did not let you sign in to ${host} with a saved password.`);
      itemId = matches.some((m) => m.id === ans.account) ? ans.account : matches[0].id;
      if (ans.decision === 'always') b.db.setMeta('agent_login_sites', { ...(b.db.getMeta('agent_login_sites', {}) || {}), [`${s.client}|${origin}`]: Date.now() });
    }
    try {
      await b.autofill.fillItem(tab, frame, itemId);
    } catch (e) {
      throw new AgentError(e.message === 'other_host' ? `The saved login is for a different site than ${host}.` : e.message);
    }
    return `The browser filled the sign-in form on ${host} with a saved login${username ? ` (${username})` : ''}. Now submit it (click the sign-in button) and check the result.`;
  }

  /** Feature hook: the page's right-click menu offers to share a normal tab with a connected agent, or take it back. */
  contextMenuItems(tab) {
    if (!this.server || tab.private || tab.ctl.agent || !/^(https?|file):/i.test(tab.wc.getURL())) return [];
    const owner = this.owners.get(tab.id);
    if (owner) {
      return [
        {
          label: `Stop sharing this tab with ${owner.client}`,
          click: () => this.revokeControl(tab),
        },
      ];
    }
    return [...this.sessions.values()].slice(0, 5).map((s) => ({
      label: `Share this tab with ${s.client}${s.label ? ` (${s.label})` : ''}`,
      click: () => {
        this.share(s, tab);
        s.current = tab.id;
        this.refresh(s);
      },
    }));
  }

  // ------------------------------------------------------------------------------- UI: toolbar
  refresh(s = null) {
    if (s && s.window && !s.window.destroyed) {
      s.window.agent = this.sessions.has(s.key) ? s.info() : null;
    }
    this.browser.refreshToolbar();
  }

  toolbarButtons(ctl) {
    if (!this.server || ctl.private) return [];
    const active = [...this.sessions.values()];
    if (!active.length && !ctl.agent) return [];
    const busy = active.filter((s) => s.busy > 0).length;
    return [{ id: 'agents', order: 5, icon: 'bot', title: busy ? `AI agents — ${busy} working` : `AI agents — ${active.length} connected`, badge: active.length || null, tone: busy ? 'accent' : undefined, pressed: busy > 0, popup: { kind: 'agents', width: 360 } }];
  }

  agentsData() {
    return {
      on: this.on,
      sessions: [...this.sessions.values()].map((s) => ({
        key: s.key,
        client: s.client,
        label: s.label,
        busy: s.busy > 0,
        stopped: s.stopped,
        tabs: s.tabs.size + s.shared.size,
        calls: s.calls,
        lastTool: s.lastTool,
        lastUsed: s.lastUsed,
      })),
    };
  }

  openPopup(ctl, kind, anchor) {
    return ctl.showPopup(kind, this.agentsData(), { ...anchor, width: 360 });
  }

  popupAction(ctl, kind, action, d) {
    const s = d && d.key ? this.sessions.get(String(d.key)) : null;
    switch (action) {
      case 'stop':
        if (s) {
          s.stopped = true;
          for (const ac of s.inflight.values()) ac.abort();
        }
        break;
      case 'resume':
        if (s) s.stopped = false;
        break;
      case 'disconnect':
        if (s) this.endSession(s, 'disconnected by the user');
        break;
      case 'show':
        if (s && s.window && !s.window.destroyed) s.window.win.show();
        break;
      case 'stop-all':
        for (const x of this.sessions.values()) {
          x.stopped = true;
          for (const ac of x.inflight.values()) ac.abort();
        }
        break;
      case 'turn-off':
        ctl.hidePopup('agents');
        this.browser.prefs.update({ agentAccess: false });
        return null;
      case 'settings':
        ctl.hidePopup('agents');
        this.openSettings(ctl);
        return null;
      default:
        break;
    }
    this.refresh(s);
    return this.agentsData();
  }

  openSettings(ctl) {
    const t = this.browser.openInternal(ctl, 'settings');
    if (t) setTimeout(() => !t.wc.isDestroyed() && t.wc.executeJavaScript("location.hash = '#agents'", true).catch(() => {}), 300);
  }

  notifyPages() {
    for (const w of this.browser.windows) {
      for (const t of w.tabs) if (!t.wc.isDestroyed() && /^ludworks:\/\/settings\//.test(t.wc.getURL())) t.wc.send('page-event', { type: 'agents' });
    }
  }

  // ------------------------------------------------------------------------- settings page
  cliPath() {
    const exe = process.platform === 'win32' ? 'lwb.exe' : 'lwb';
    const candidates = [path.join(path.dirname(process.execPath), exe)];
    if (!app.isPackaged || this.browser.dev) candidates.push(path.join(this.browser.appDir, '..', '..', 'tools', 'bin', exe));
    if (process.env.LWB_PATH) candidates.unshift(process.env.LWB_PATH);
    return candidates.find((p) => existsSync(p)) || candidates[0];
  }

  visionInfo() {
    const vp = visionPaths({ home: os.homedir() });
    let settings = null;
    try {
      settings = JSON.parse(readFileSync(vp.settings, 'utf8').replace(/^﻿/, ''));
    } catch {
      settings = null;
    }
    return { ...vp, found: existsSync(vp.root), shell: visionShell(settings), installed: existsSync(path.join(vp.plugins, VISION_PLUGIN_FILE)) };
  }

  async pageCommand(_tab, cmd, a) {
    const b = this.browser;
    switch (cmd) {
      case 'agent.state': {
        const cli = this.cliPath();
        const vision = this.visionInfo();
        const claude = findOnPath(process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude']) || findClaudeFallback();
        return {
          on: this.on,
          running: !!this.server,
          port: this.port,
          endpoint: path.join(b.profileDir, ENDPOINT_FILE),
          scope: b.prefs.get('agentScope'),
          scripts: b.prefs.get('agentScripts') !== false,
          logins: b.prefs.get('agentLogins'),
          clients: Object.entries(this.clients()).map(([name, v]) => ({ name, added: v.added || 0 })),
          sessions: this.agentsData().sessions,
          cli: { path: cli, exists: existsSync(cli) },
          claude: { path: claude, configured: claudeConfigured(), desktop: claude ? null : claudeDesktopConfig() },
          vision: { found: vision.found, installed: vision.installed, shell: vision.shell, plugins: vision.plugins },
          mcpJson: JSON.stringify(mcpStdioConfig(cli), null, 2),
        };
      }
      case 'agent.set': {
        const patch = {};
        if (typeof a.on === 'boolean') patch.agentAccess = a.on;
        if (a.scope === 'own' || a.scope === 'all') patch.agentScope = a.scope;
        if (typeof a.scripts === 'boolean') patch.agentScripts = a.scripts;
        if (['ask', 'allow', 'never'].includes(a.logins)) patch.agentLogins = a.logins;
        b.prefs.update(patch);
        return { ok: true };
      }
      case 'agent.forget-client': {
        const c = { ...this.clients() };
        delete c[String(a.name)];
        b.db.setMeta('agent_clients', c);
        this.allowedOnce.delete(String(a.name));
        for (const s of [...this.sessions.values()]) if (s.client === a.name) this.endSession(s, 'client forgotten');
        return { ok: true };
      }
      case 'agent.reset-token':
        b.db.setMeta('agent_token', newToken());
        if (this.server) {
          this.stop();
          await this.start();
        }
        return { ok: true };
      case 'agent.copy': {
        const cli = this.cliPath();
        const what = String(a.what || '');
        const text = what === 'mcp-json' ? JSON.stringify(mcpStdioConfig(cli), null, 2) : what === 'http-json' && this.server ? JSON.stringify(mcpHttpConfig(this.port, this.server.token), null, 2) : what === 'claude-command' ? commandLine(['claude', ...claudeAddArgs(cli)]) : cli;
        clipboard.writeText(text);
        return { ok: true };
      }
      case 'agent.setup-claude':
        return this.setupClaude(!!a.allow);
      case 'agent.setup-vision':
        return this.setupVision();
      default:
        throw new Error('not allowed');
    }
  }

  async setupClaude(allow) {
    const cli = this.cliPath();
    if (!existsSync(cli)) return { ok: false, error: `The lwb program is missing (${cli}). Reinstall Ludworks Browser.` };
    const claude = findOnPath(process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude']) || findClaudeFallback();
    const done = [];
    // the skill: workflow guidance Claude Code (and Vision, which reads ~/.claude/skills) loads when it fits
    const skillDir = path.join(os.homedir(), '.claude', 'skills', SERVER_NAME);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), skillMarkdown());
    done.push(`Skill written to ${path.join(skillDir, 'SKILL.md')}`);
    if (allow) {
      const file = path.join(os.homedir(), '.claude', 'settings.json');
      let current = '';
      try {
        current = readFileSync(file, 'utf8');
      } catch {
        current = '';
      }
      const next = allowInClaudeSettings(current);
      if (next) {
        writeFileSync(file, next);
        done.push(`Claude Code may use the browser tools without asking each time (${file})`);
      } else if (current && !current.includes(`mcp__${SERVER_NAME}`)) done.push(`Could not update ${file} (not plain JSON): allow mcp__${SERVER_NAME} in /permissions yourself`);
    }
    if (claude) {
      await runQuiet(claude, ['mcp', 'remove', '--scope', 'user', SERVER_NAME]).catch(() => null);
      const add = await runQuiet(claude, claudeAddArgs(cli)).catch((e) => ({ code: -1, out: '', err: e.message }));
      if (add.code !== 0) return { ok: false, error: `claude mcp add failed: ${(add.err || add.out).trim().slice(0, 500)}`, done, command: commandLine(['claude', ...claudeAddArgs(cli)]) };
      done.unshift('Added the ludworks-browser MCP server to Claude Code (all projects)');
      return { ok: true, done, note: 'Start a new Claude Code session to use it.' };
    }
    // No claude command: the Claude desktop app (its Code tab and chat) reads claude_desktop_config.json.
    const desktop = claudeDesktopConfig();
    if (desktop) {
      const r = mergeMcpConfig(desktop, cli);
      if (r.ok) {
        done.unshift(r.changed ? `Added the ludworks-browser MCP server to the Claude desktop app (${desktop})` : `The Claude desktop app already has the ludworks-browser MCP server (${desktop})`);
        return { ok: true, done, note: 'Restart the Claude app (quit it from the tray) so its Code tab and chat load the browser tools.' };
      }
      done.push(`Could not update ${desktop}: ${r.error}`);
    }
    return { ok: false, error: 'Neither the claude command nor the Claude desktop app was found. Install Claude Code, or run the command below yourself.', done, command: commandLine(['claude', ...claudeAddArgs(cli)]) };
  }

  async setupVision() {
    const cli = this.cliPath();
    if (!existsSync(cli)) return { ok: false, error: `The lwb program is missing (${cli}). Reinstall Ludworks Browser.` };
    const v = this.visionInfo();
    mkdirSync(v.plugins, { recursive: true });
    const file = path.join(v.plugins, VISION_PLUGIN_FILE);
    writeFileSync(file, `${JSON.stringify(visionManifest({ exe: cli, shell: v.shell, version: app.getVersion() }), null, 2)}\n`);
    const skillDir = path.join(v.skills, SERVER_NAME);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), skillMarkdown());
    return { ok: true, done: [`Plugin written to ${file} (commands for ${v.shell === 'powershell' ? 'PowerShell' : v.shell === 'cmd' ? 'cmd.exe' : 'bash'})`, `Skill written to ${path.join(skillDir, 'SKILL.md')}`], note: 'In Vision: Settings › Plugins › Reload (or restart Vision).' };
  }
}

// ------------------------------------------------------------------------------------ helpers
function findOnPath(names) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d.replace(/^"|"$/g, ''), n);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/** Claude Code's native installer puts it in ~/.local/bin, which a GUI app's PATH may not have yet. */
function findClaudeFallback() {
  const home = os.homedir();
  const list = process.platform === 'win32' ? [path.join(home, '.local', 'bin', 'claude.exe'), path.join(process.env.APPDATA || '', 'npm', 'claude.cmd')] : [path.join(home, '.local', 'bin', 'claude'), path.join(home, '.claude', 'local', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude'];
  return list.find((p) => p && existsSync(p)) || null;
}

/** The Claude desktop app's MCP config file: an existing one, else where a present app would read it, else null. */
function claudeDesktopConfig() {
  const list = (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  const paths = claudeDesktopConfigPaths({ home: os.homedir(), list, exists: existsSync });
  return paths.find((p) => existsSync(p) || existsSync(path.dirname(p))) || null;
}

/** Adds the server to an MCP config file: parsed and validated first, written atomically, read back. */
function mergeMcpConfig(file, exe) {
  let text = '';
  try {
    text = readFileSync(file, 'utf8').replace(/^﻿/, '');
  } catch (e) {
    if (e.code !== 'ENOENT') return { ok: false, error: e.message };
  }
  const next = addMcpServer(text, exe);
  if (next === null) {
    try {
      const cur = text.trim() ? JSON.parse(text) : null;
      if (cur && cur.mcpServers && cur.mcpServers[SERVER_NAME]) return { ok: true, changed: false };
    } catch {
      /* fall through */
    }
    return { ok: false, error: 'it is not plain JSON — add the server by hand' };
  }
  try {
    const tmp = `${file}.ludworks-${process.pid}.tmp`;
    writeFileSync(tmp, next);
    renameSync(tmp, file);
    const back = JSON.parse(readFileSync(file, 'utf8'));
    return back.mcpServers && back.mcpServers[SERVER_NAME] ? { ok: true, changed: true } : { ok: false, error: 'the change did not stick' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function claudeConfigured() {
  for (const f of [path.join(os.homedir(), '.claude.json'), claudeDesktopConfig()]) {
    try {
      const cfg = f && JSON.parse(readFileSync(f, 'utf8').replace(/^﻿/, ''));
      if (cfg && cfg.mcpServers && cfg.mcpServers[SERVER_NAME]) return true;
    } catch {
      /* missing or unreadable */
    }
  }
  return false;
}

function quoteArg(a) {
  return /^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`;
}

function commandLine(argv) {
  return argv.map(quoteArg).join(' ');
}

/** Runs a program (a .cmd through cmd.exe) and collects its output. */
function runQuiet(file, args) {
  return new Promise((resolve, reject) => {
    let child;
    if (process.platform === 'win32' && /\.cmd$/i.test(file)) {
      const line = [file, ...args].map((x) => `"${String(x).replace(/"/g, '""')}"`).join(' ');
      child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { windowsVerbatimArguments: true, windowsHide: true });
    } else child = spawn(file, args, { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), 60000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}
