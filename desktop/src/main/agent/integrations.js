// Setting up harnesses: the Vision plugin manifest (tools backed by lwb commands), the skill shared by
// Claude Code and Vision, and MCP client configuration. No Electron here (unit-tested).
//
// Vision runs a plugin tool by substituting ${param} — quoted for its agent shell — into the command
// template and running it in that shell. Windows PowerShell 5.1 garbles native arguments that contain
// double quotes, so the PowerShell template hands the values to lwb on stdin instead: each one in a
// single-quoted here-string (nothing inside expands; Vision's quoting doubles every quote, so no line
// can end the here-string early), collected with ConvertTo-Json; `lwb --ps-quoted` undoes the quoting.

import path from 'node:path';
import { toolList, toolTimeout, INSTRUCTIONS } from './tools.js';

export const SERVER_NAME = 'ludworks-browser';
export const VISION_PLUGIN_FILE = 'ludworks-browser.json';
const MAX_OUTPUT = 15000; // Vision keeps ~16 KB of a command's output (the tail): lwb cuts first, keeping the head

/** Folders of a Vision installation (VISION_HOME overrides, like Vision itself). */
export function visionPaths({ platform = process.platform, env = process.env, home = '' } = {}) {
  let root;
  if (env.VISION_HOME) root = env.VISION_HOME;
  else if (platform === 'win32') root = path.win32.join(env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'), 'Vision');
  else if (platform === 'darwin') root = path.posix.join(home, 'Library', 'Application Support', 'Vision');
  else root = path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(home, '.config'), 'Vision');
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return { root, plugins: join(root, 'plugins'), skills: join(root, 'skills'), settings: join(root, 'settings.json') };
}

/** The shell Vision runs plugin commands in, from its settings.json `agentShell` ("auto" = PowerShell on Windows). */
export function visionShell(settings, platform = process.platform) {
  if (platform !== 'win32') return 'bash';
  const pref = String((settings && settings.agentShell) || 'auto').trim().toLowerCase();
  if (pref === 'cmd') return 'cmd';
  if (pref === 'bash') return 'bash';
  if (['auto', '', 'powershell', 'windowspowershell'].includes(pref)) return 'powershell';
  const base = pref.split(/[\\/]/).pop().replace(/\.exe$/, '');
  if (base === 'cmd') return 'cmd';
  if (base === 'pwsh' || base === 'powershell') return 'powershell';
  return 'bash';
}

const psLiteral = (s) => `'${String(s).replace(/['‘’‚‛]/g, (c) => c + c)}'`;
const shLiteral = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/**
 * Vision command template of one tool.
 * @param {{name: string, inputSchema: any}} tool
 * @param {{exe: string, shell: 'powershell'|'cmd'|'bash', platform?: string}} o
 */
export function visionCommand(tool, { exe, shell, platform = process.platform }) {
  const params = Object.keys(tool.inputSchema.properties || {});
  const flags = `--client=Vision --max-output=${MAX_OUTPUT}`;
  if (shell === 'powershell') {
    const call = `& ${psLiteral(exe)} ${flags} --ps-quoted ${tool.name}`;
    if (!params.length) return call;
    const fields = params.map((p) => `${p}=@'\n\${${p}}\n'@`).join('\n');
    return `@{\n${fields}\n} | ConvertTo-Json -Compress | ${call} --stdin`;
  }
  const args = params.map((p) => ` --${p}=\${${p}}`).join('');
  if (shell === 'cmd') return `"${exe}" ${flags} ${tool.name}${args}`;
  // bash: Git Bash on Windows (forward slashes; no MSYS path conversion of values that look like paths), or macOS/Linux
  const p = platform === 'win32' ? exe.replace(/\\/g, '/') : exe;
  return `MSYS_NO_PATHCONV=1 ${shLiteral(p)} ${flags} ${tool.name}${args}`;
}

/** Extra sentence for Vision, whose plugin output is text only. */
function visionDescription(tool) {
  if (tool.name === 'browser_screenshot') return `${tool.description} The image is saved to a file: look at it with view_image (file_path from the result).`;
  return tool.description;
}

/**
 * The plugin manifest for %APPDATA%\Vision\plugins (or ~/Library/Application Support/Vision/plugins).
 * The browser itself asks the user before an agent may use it, so Vision is not asked to confirm each call.
 */
export function visionManifest({ exe, shell, platform = process.platform, version = '' }) {
  return {
    name: SERVER_NAME,
    description: "Ludworks Browser — open, read and operate web pages in the user's own browser (their signed-in sites), take screenshots, sign in with saved passwords without seeing them.",
    version: String(version || ''),
    tools: toolList().map((t) => ({
      name: t.name,
      description: visionDescription(t),
      parameters: t.inputSchema,
      command: visionCommand(t, { exe, shell, platform }),
      requiresApproval: false,
      timeout: Math.min(600, toolTimeout(t.name) + 30),
    })),
  };
}

/** SKILL.md for ~/.claude/skills/ludworks-browser (Claude Code and Vision both read it) and Vision's own skills folder. */
export function skillMarkdown() {
  return `---
name: ${SERVER_NAME}
description: Use the user's own web browser (Ludworks Browser) to open web pages, read them, fill in forms, click, sign in with saved passwords, download files and take screenshots. Use it for any task that needs a real browser, JavaScript-heavy sites, or the user's signed-in accounts.
---

# Ludworks Browser

The browser tools are named \`browser_*\` (in Claude Code: \`mcp__${SERVER_NAME}__browser_*\`; in Vision: the
\`${SERVER_NAME}\` plugin). They drive the user's real Ludworks Browser in a window of your own.

${INSTRUCTIONS}

## Working well

1. \`browser_navigate\` returns an interactive snapshot of the page. Act on refs from it: \`browser_click ref=e12\`,
   \`browser_type ref=e7 text="…" submit=true\`, \`browser_fill_form fields=[{"ref":"e7","value":"…"}, …]\`.
2. Each action reports what happened (navigation, new tab, dialog, download). Take a fresh \`browser_snapshot\`
   (filter=interactive for just the controls) before using refs on a changed page.
3. Use \`browser_find query="…"\` on big pages instead of reading the whole snapshot, and \`browser_read\` to read
   articles, docs and results as text.
4. Look at the page with \`browser_screenshot\` when layout or visuals matter (annotate=true labels refs on it).
   In Vision the image is saved to a file: open it with \`view_image\`.
5. Waiting: \`browser_wait_for text="…"\` (or text_gone, selector, url, network_idle) instead of sleeping.
6. Dialogs block the page: answer them with \`browser_handle_dialog\`.
7. Several predictable steps: \`browser_batch\` runs them in one call.
8. Sign-in forms: \`browser_fill_login\`, then click the sign-in button. If the vault is locked or the user says
   no, ask the user to sign in themselves.
9. When finished, close the tabs you opened (\`browser_tabs action=close_all\`) unless the user wants to see them.
`;
}

/** `claude mcp add` arguments (user scope: every project). */
export function claudeAddArgs(exe) {
  return ['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', exe, 'mcp'];
}

/** Configuration for other MCP clients (Cursor, Claude Desktop, VS Code, Windsurf…): stdio through lwb. */
export function mcpStdioConfig(exe) {
  return { mcpServers: { [SERVER_NAME]: { command: exe, args: ['mcp'] } } };
}

/** For clients that only speak HTTP: the server's own endpoint and token. */
export function mcpHttpConfig(port, token) {
  return { mcpServers: { [SERVER_NAME]: { type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}` } } } };
}

/**
 * Where the Claude desktop app keeps claude_desktop_config.json. Its Code tab loads the MCP servers listed
 * there (as does the app's chat), so without the claude command the browser is added there. Newer Windows
 * builds keep their data in %LOCALAPPDATA%\Claude-Data\claude_<package id>; older ones in %APPDATA%\Claude,
 * which then only holds a ".user-data-left" marker. Existing files first.
 * @param {{platform?: string, env?: any, home?: string, list?: (dir: string) => string[], exists?: (p: string) => boolean}} o
 */
export function claudeDesktopConfigPaths({ platform = process.platform, env = process.env, home = '', list = () => [], exists = () => false } = {}) {
  const out = [];
  if (platform === 'win32') {
    const j = path.win32.join;
    const local = env.LOCALAPPDATA || j(home, 'AppData', 'Local');
    const roaming = env.APPDATA || j(home, 'AppData', 'Roaming');
    for (const d of list(j(local, 'Claude-Data'))) if (/^claude_/i.test(d)) out.push(j(local, 'Claude-Data', d, 'claude_desktop_config.json'));
    const legacy = j(roaming, 'Claude');
    if (!list(legacy).some((n) => n.startsWith('.user-data-left'))) out.push(j(legacy, 'claude_desktop_config.json'));
  } else if (platform === 'darwin') out.push(path.posix.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
  else out.push(path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(home, '.config'), 'Claude', 'claude_desktop_config.json'));
  return [...out.filter((p) => exists(p)), ...out.filter((p) => !exists(p))];
}

/** Adds (or updates) the browser's MCP server in an MCP config file's text — {"mcpServers": {...}}, other
 *  keys untouched. null when the text is not a JSON object or already has exactly this entry. */
export function addMcpServer(text, exe) {
  let cfg;
  try {
    cfg = text && text.trim() ? JSON.parse(text) : {};
  } catch {
    return null;
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return null;
  const servers = cfg.mcpServers && typeof cfg.mcpServers === 'object' && !Array.isArray(cfg.mcpServers) ? cfg.mcpServers : {};
  const entry = { command: exe, args: ['mcp'] };
  if (JSON.stringify(servers[SERVER_NAME]) === JSON.stringify(entry)) return null;
  cfg.mcpServers = { ...servers, [SERVER_NAME]: entry };
  return `${JSON.stringify(cfg, null, 2)}\n`;
}

/** Adds the browser's tools to the allow list of Claude Code's settings.json text (null: unchanged/unparseable). */
export function allowInClaudeSettings(text) {
  let s;
  try {
    s = text && text.trim() ? JSON.parse(text) : {};
  } catch {
    return null;
  }
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  const rule = `mcp__${SERVER_NAME}`;
  s.permissions = s.permissions && typeof s.permissions === 'object' && !Array.isArray(s.permissions) ? s.permissions : {};
  const allow = Array.isArray(s.permissions.allow) ? s.permissions.allow : [];
  if (allow.includes(rule)) return null;
  s.permissions.allow = [...allow, rule];
  return `${JSON.stringify(s, null, 2)}\n`;
}
