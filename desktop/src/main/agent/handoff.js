// Sending a page to an AI app (send.js): which apps, the prompt they get, and how each one is reached.
// No Electron here (unit-tested).
//
//   Vision      launched with the handoff folder (it opens it as a project; request.md holds the prompt) and
//               --ludworks-request=<request.json>; the prompt is also on the clipboard.
//   OpenClaw    POST <gateway>/hooks/agent with the hook token (docs.openclaw.ai, gateway/config-hooks):
//               an agent turn with the prompt as its message. Files are referenced by path.
//   Claude      claude://claude.ai/new?q=<prompt> (chat) or claude://code/new?q=<prompt>&folder=<handoff>
//               (a Claude Code session in the handoff folder) — support.claude.com "Open Claude Desktop with a link".
//
// With "let it control this page" the app may also operate the page through the browser's agent tools
// (agent.js grantControl): the prompt says which tab, and how to reach the tools.

import path from 'node:path';

export const HARNESSES = Object.freeze({
  vision: { id: 'vision', name: 'Vision', setting: 'vision', clients: ['Vision'], cliClient: 'Vision' },
  openclaw: { id: 'openclaw', name: 'OpenClaw', setting: 'openclaw', clients: ['OpenClaw'], cliClient: 'OpenClaw' },
  claude: { id: 'claude', name: 'Claude', setting: 'claude', clients: ['Claude', 'Claude Code'], cliClient: 'Claude' },
  'claude-code': { id: 'claude-code', name: 'Claude Code', setting: 'claude', clients: ['Claude Code', 'Claude'], cliClient: 'Claude Code' },
});

export const DEFAULT_SEND_TO = Object.freeze({ vision: false, openclaw: false, claude: false });
export const CLAUDE_PROMPT_MAX = 14000; // Claude Desktop truncates a prefilled prompt at about this many characters
const MESSAGE_MAX = 200 * 1024; // OpenClaw hook bodies are limited to 256 KiB

/** Harness ids the user turned on (prefs.sendTo), in menu order. */
export function enabledHarnesses(sendTo) {
  const on = { ...DEFAULT_SEND_TO, ...(sendTo && typeof sendTo === 'object' ? sendTo : {}) };
  return Object.values(HARNESSES)
    .filter((h) => on[h.setting] === true)
    .map((h) => h.id);
}

export function validSendTo(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every((k) => Object.hasOwn(DEFAULT_SEND_TO, k) && typeof v[k] === 'boolean');
}

/** Folder name of one handoff: sortable, readable, safe on every file system. */
export function handoffDirName(date, url) {
  const p = (n) => String(n).padStart(2, '0');
  let host = 'page';
  try {
    host = new URL(url).hostname || 'page';
  } catch {
    /* keep */
  }
  host = host.replace(/^www\./, '').replace(/[^a-z0-9.-]/gi, '_').slice(0, 60);
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())} ${host}`;
}

/**
 * The prompt an AI app gets.
 * @param {{narrative?: string, page: {title?: string, url: string}, snapshot?: {dir: string, screenshot?: string, html?: string, assets?: string, text?: string}|null,
 *   control?: {tabId: number, cli?: string, client: string, mcp?: boolean}|null, imageOnClipboard?: boolean, local?: boolean}} o
 *   local: the app can read files on this computer (all but Claude chat)
 */
export function handoffPrompt({ narrative = '', page, snapshot = null, control = null, imageOnClipboard = false, local = true }) {
  const ask = String(narrative || '').trim() || 'Take a look at this web page and tell me what you think I would want to know about it.';
  const lines = [ask, '', '---', `Web page sent from Ludworks Browser: ${page.title ? `“${String(page.title).slice(0, 300)}” ` : ''}${page.url}`];
  if (snapshot && local) {
    lines.push('', `A snapshot of the page is in this folder: ${snapshot.dir}`);
    if (snapshot.screenshot) lines.push(`- ${path.basename(snapshot.screenshot)}: screenshot of what the user sees`);
    if (snapshot.html) lines.push(`- ${path.basename(snapshot.html)}${snapshot.assets ? ` and ${path.basename(snapshot.assets)}/` : ''}: the page's HTML with its CSS, JavaScript and images`);
    if (snapshot.text) lines.push(`- ${path.basename(snapshot.text)}: the page's visible text`);
  } else if (imageOnClipboard) lines.push('', 'A screenshot of the page is on the clipboard: paste it into this chat (Ctrl+V / ⌘V).');
  if (control) {
    lines.push('', `The user lets you control this page in Ludworks Browser: it is tab ${control.tabId}, already shared with you as your current tab.`);
    if (control.mcp) lines.push('Use the ludworks-browser tools (browser_snapshot to read it, then browser_click, browser_type, browser_navigate, browser_screenshot…).');
    if (control.cli) lines.push(`${control.mcp ? 'Or use' : 'Use'} the browser's command line: "${control.cli}" --client="${control.client}" browser_snapshot — then browser_click --ref=… , browser_type --ref=… --text=… ("${path.basename(control.cli)}" tools lists them all; add --tab=${control.tabId} if you open other tabs).`);
    lines.push('The user sees that you control the page and can stop you at any time.');
  }
  return lines.join('\n');
}

/** claude:// link that opens Claude Desktop with the prompt filled in (never sent by itself). */
export function claudeLink(kind, prompt, folder = '') {
  let q = String(prompt || '');
  if (q.length > CLAUDE_PROMPT_MAX) q = `${q.slice(0, CLAUDE_PROMPT_MAX - 1)}…`;
  if (kind === 'claude-code') return `claude://code/new?q=${encodeURIComponent(q)}${folder ? `&folder=${encodeURIComponent(folder)}` : ''}`;
  return `claude://claude.ai/new?q=${encodeURIComponent(q)}`;
}

/**
 * Minimal JSON5 reader for ~/.openclaw/openclaw.json: comments, unquoted keys, single-quoted strings and
 * trailing commas become JSON. Returns null when it still does not parse.
 */
export function parseJson5(text) {
  const src = String(text || '').replace(/^﻿/, '');
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") {
      let s = '';
      let j = i + 1;
      for (; j < src.length && src[j] !== c; j++) {
        if (src[j] === '\\' && j + 1 < src.length) {
          s += src[j] + src[j + 1];
          j++;
        } else if (src[j] === '"') s += '\\"';
        else s += src[j];
      }
      out += `"${c === "'" ? s.replace(/\\'/g, "'") : s}"`;
      i = j;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 1;
    } else if (/[A-Za-z_$]/.test(c) && /[{,]\s*$/.test(out)) {
      let j = i;
      while (j < src.length && /[\w$]/.test(src[j])) j++;
      const word = src.slice(i, j);
      out += /^\s*:/.test(src.slice(j)) ? `"${word}"` : word;
      i = j - 1;
    } else out += c;
  }
  out = out.replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/** Where OpenClaw's gateway takes hooks, from its config: {url, token, enabled} (token '' when not set up). */
export function openclawHookConfig(configText, { baseUrl = '' } = {}) {
  const cfg = parseJson5(configText) || {};
  const hooks = (cfg && cfg.hooks) || {};
  const gw = (cfg && cfg.gateway) || {};
  const port = Number.isInteger(gw.port) && gw.port > 0 && gw.port < 65536 ? gw.port : 18789;
  const hookPath = typeof hooks.path === 'string' && hooks.path.startsWith('/') && hooks.path !== '/' ? hooks.path.replace(/\/+$/, '') : '/hooks';
  const base = String(baseUrl || '').trim().replace(/\/+$/, '') || `http://127.0.0.1:${port}`;
  return { url: `${base}${hookPath}/agent`, token: typeof hooks.token === 'string' ? hooks.token : '', enabled: hooks.enabled === true };
}

/** The /hooks/agent request (method POST). */
export function openclawRequest({ url, token, message, name = 'Ludworks Browser', idempotencyKey = '' }) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return { url, headers, body: JSON.stringify({ message: String(message).slice(0, MESSAGE_MAX), name }) };
}

/** A one-line reason for an OpenClaw hook reply that was not 200. */
export function openclawError(status, bodyText = '') {
  if (status === 401) return 'OpenClaw refused the hook token. Check it in Settings → AI agents → Send pages to AI apps.';
  if (status === 404) return 'OpenClaw has no hooks endpoint there: turn on hooks (hooks.enabled and hooks.token in ~/.openclaw/openclaw.json) and restart the gateway.';
  if (status === 429 || status === 503) return 'OpenClaw is busy right now. Try again in a moment.';
  if (status === 413) return 'The message was too large for OpenClaw.';
  const detail = String(bodyText || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  return `OpenClaw answered ${status}${detail ? `: ${detail}` : ''}.`;
}

/** Where Vision may be installed (Windows: its Inno Setup installer; macOS: the app bundle). */
export function visionCandidates({ platform = process.platform, env = process.env, home = '' } = {}) {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local');
    return [path.win32.join(local, 'Programs', 'Vision', 'Vision.exe'), env.ProgramFiles && path.win32.join(env.ProgramFiles, 'Vision', 'Vision.exe'), env['ProgramFiles(x86)'] && path.win32.join(env['ProgramFiles(x86)'], 'Vision', 'Vision.exe')].filter(Boolean);
  }
  if (platform === 'darwin') return ['/Applications/Vision.app', path.posix.join(home, 'Applications', 'Vision.app')];
  return [];
}

/** How to start Vision on a handoff folder: {file, args}. */
export function visionLaunch(exe, dir, requestFile, platform = process.platform) {
  const args = [dir, `--ludworks-request=${requestFile}`];
  if (platform === 'darwin') return { file: 'open', args: ['-a', exe, '--args', ...args] };
  return { file: exe, args };
}
