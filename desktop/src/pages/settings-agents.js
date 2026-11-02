// Settings → AI agents: turn agent access on, what agents may use, connect Claude Code / Vision / other
// MCP clients, and the agents allowed so far (src/main/agent/agent.js).
import { h, clear, toggle } from './ui.js';

/** @param {(cmd: string, args?: any) => Promise<any>} call */
export function agentsSection(call) {
  const head = h('h2', { id: 'agents' }, 'AI agents');
  const main = h('div', { class: 'card' }, h('div', { class: 'setting muted' }, 'Loading…'));
  const connect = h('div', { class: 'card' });
  const allowed = h('div', { class: 'card' });
  const note = (box, r) => {
    const lines = [...(r.done || []).map((d) => `✓ ${d}`), ...(r.error ? [r.error] : []), ...(r.note ? [r.note] : [])];
    clear(box);
    for (const l of lines) box.append(h('div', { class: l.startsWith('✓') ? '' : 'muted' }, l));
    if (r.command) box.append(h('pre', { class: 'ag-pre' }, r.command));
  };
  const setting = (title, desc, control) => h('div', { class: 'setting' }, h('div', { class: 'grow' }, h('div', {}, title), desc ? h('div', { class: 'd' }, desc) : null), control);
  const select = (options, value, onchange) => {
    const s = h('select', { class: 'input', style: { width: '240px' } }, ...options.map(([v, l]) => h('option', { value: v }, l)));
    s.value = String(value);
    s.addEventListener('change', () => onchange(s.value));
    return s;
  };
  const set = async (patch) => {
    await call('agent.set', patch);
    refresh();
  };

  const render = (st) => {
    clear(main);
    main.append(
      setting(
        'Let AI agents use Ludworks Browser',
        'Coding agents on this computer — Claude Code, Vision, other MCP clients — can open pages in a window of their own, read them, click and type, and take screenshots. Each agent asks you once; you can stop it from the toolbar at any time. They never see your passwords, private windows or these settings.',
        toggle(st.on, (on) => set({ on }), 'Let AI agents use Ludworks Browser'),
      ),
    );
    if (st.on) main.append(h('div', { class: 'setting muted' }, st.running ? `Listening on 127.0.0.1:${st.port} — only programs on this computer, with the access key in ${st.endpoint}.` : 'Starting…'));
    main.append(
      setting('Tabs agents can use', 'An agent always works in its own window. Your other tabs stay private unless you share one with it.', select([['own', 'Only their own (and tabs I share)'], ['all', 'All my tabs (not private windows)']], st.scope, (v) => set({ scope: v }))),
      setting('Let agents run JavaScript in pages', 'For checks and data extraction (browser_evaluate). Clicking and typing work without it.', toggle(st.scripts, (v) => set({ scripts: v }), 'Let agents run JavaScript')),
      setting(
        'Sign-ins with saved passwords',
        'The browser fills the password itself (browser_fill_login); the agent never sees it.',
        select([['ask', 'Ask me (or sites I always allow)'], ['allow', 'Allow when there is one saved login'], ['never', 'Never']], st.logins, (v) => set({ logins: v })),
      ),
    );

    clear(connect);
    const claudeOut = h('div', { class: 'stack ag-out' });
    const allow = h('input', { type: 'checkbox', checked: true });
    connect.append(
      h('div', { class: 'setting' }, h('div', { class: 'grow' }, h('div', {}, 'Claude Code'), h('div', { class: 'd' }, `${st.claude.path ? `Found at ${st.claude.path}: adds the browser as an MCP server for all your projects.` : st.claude.desktop ? 'Found the Claude desktop app: adds the browser to its MCP servers (its Code tab and chat; restart the app afterwards).' : 'Not found on this computer (install it, or copy the command).'}${st.claude.configured ? ' Already connected.' : ''} Also writes a skill that teaches it the workflow.`), h('label', { class: 'ag-check' }, allow, "Don't ask before each browser action (the browser still asks once)"), claudeOut), h('div', { class: 'ag-btns' }, h('button', { class: 'btn primary', onclick: async () => note(claudeOut, await call('agent.setup-claude', { allow: allow.checked })) }, st.claude.configured ? 'Connect again' : 'Connect Claude Code'), h('button', { class: 'btn', onclick: () => call('agent.copy', { what: 'claude-command' }) }, 'Copy command'))),
    );
    const visionOut = h('div', { class: 'stack ag-out' });
    connect.append(
      h('div', { class: 'setting' }, h('div', { class: 'grow' }, h('div', {}, 'Vision'), h('div', { class: 'd' }, `${st.vision.found ? 'Found.' : 'Not found (it will be set up for when you install it).'}${st.vision.installed ? ' The plugin is installed.' : ''} Adds the browser tools as a Vision plugin (${st.vision.shell === 'powershell' ? 'PowerShell' : st.vision.shell} commands) and its skill. Then reload plugins in Vision (Settings › Plugins).`), visionOut), h('button', { class: 'btn primary', onclick: async () => note(visionOut, await call('agent.setup-vision')) }, st.vision.installed ? 'Update Vision plugin' : 'Add to Vision')),
    );
    connect.append(
      h('div', { class: 'setting', style: { flexWrap: 'wrap' } }, h('div', { class: 'grow' }, h('div', {}, 'Other MCP clients (Cursor, Claude Desktop, VS Code, Codex…)'), h('div', { class: 'd' }, 'Add this server to the client’s MCP configuration. It starts the browser when needed.'), h('pre', { class: 'ag-pre' }, st.mcpJson)), h('div', { class: 'ag-btns' }, h('button', { class: 'btn', onclick: () => call('agent.copy', { what: 'mcp-json' }) }, 'Copy'), st.running ? h('button', { class: 'btn', title: 'For clients that only connect over HTTP (contains the access key)', onclick: () => call('agent.copy', { what: 'http-json' }) }, 'Copy HTTP config') : null)),
      setting('Command line', `${st.cli.exists ? st.cli.path : `lwb is missing (${st.cli.path})`} — run "lwb tools" for the list, "lwb navigate https://…" to try it.`, h('button', { class: 'btn', onclick: () => call('agent.copy', { what: 'cli' }) }, 'Copy path')),
    );

    clear(allowed);
    if (!st.clients.length && !st.sessions.length) allowed.append(h('div', { class: 'setting muted' }, 'No agent has been allowed yet.'));
    for (const c of st.clients) allowed.append(setting(c.name, `Always allowed${c.added ? ` since ${new Date(c.added).toLocaleDateString()}` : ''}.`, h('button', { class: 'btn small', onclick: async () => { await call('agent.forget-client', { name: c.name }); refresh(); } }, 'Forget')));
    for (const s of st.sessions) allowed.append(h('div', { class: 'setting muted' }, `Connected now: ${s.client}${s.label ? ` · ${s.label}` : ''} — ${s.tabs} tab${s.tabs === 1 ? '' : 's'}, ${s.calls} action${s.calls === 1 ? '' : 's'}${s.stopped ? ' (stopped)' : ''}`));
    allowed.append(setting('Access key', 'Changing it disconnects every agent; they pick up the new key by themselves through lwb.', h('button', { class: 'btn', onclick: async () => { if (window.confirm('Disconnect all agents and make a new access key?')) { await call('agent.reset-token'); refresh(); } } }, 'New key')));
  };

  const refresh = () =>
    call('agent.state').then(render, (e) => {
      clear(main);
      main.append(h('div', { class: 'setting muted' }, `AI agents unavailable: ${e.message}`));
    });
  refresh();
  window.lwPage.on('page-event', (ev) => {
    if (ev && ev.type === 'agents') refresh();
  });
  if (!document.querySelector('link[data-agents]')) document.head.append(h('link', { rel: 'stylesheet', href: 'settings-agents.css', 'data-agents': '1' }));
  return [head, main, h('h2', { id: 'agents-connect' }, 'Connect agents'), connect, h('h2', { id: 'agents-allowed' }, 'Allowed agents'), allowed];
}

/**
 * Settings → Send pages to AI apps: which apps the "Send to AI" toolbar badge offers (src/main/agent/send.js),
 * and how to reach OpenClaw's gateway.
 * @param {(cmd: string, args?: any) => Promise<any>} call
 */
export function sendSection(call) {
  const card = h('div', { class: 'card' }, h('div', { class: 'setting muted' }, 'Loading…'));
  const setting = (title, desc, control) => h('div', { class: 'setting' }, h('div', { class: 'grow' }, h('div', {}, title), desc ? h('div', { class: 'd' }, desc) : null), control);
  const set = async (patch) => {
    await call('send.set', patch);
    refresh();
  };
  const render = (st) => {
    clear(card);
    card.append(
      h('div', { class: 'setting muted' }, 'The toolbar badge sends the page you are on — its address, or a snapshot with its HTML, CSS, JavaScript and a screenshot — to an AI app on this computer with what you want done. You can also let the app control the page: the window then glows and says which app is in control, until you stop it.'),
      setting('Vision', st.vision.found ? 'Opens the page in Vision, with your prompt on the clipboard.' : 'Vision is not installed on this computer yet.', toggle(st.sendTo.vision, (v) => set({ sendTo: { vision: v } }), 'Send pages to Vision')),
      setting('Claude', 'The Claude app: a new chat, or a Claude Code session in the page’s snapshot folder, with your prompt filled in for you to send.', toggle(st.sendTo.claude, (v) => set({ sendTo: { claude: v } }), 'Send pages to Claude')),
      setting('OpenClaw', `Starts an agent turn through the gateway’s hooks (${st.openclaw.hookUrl}). ${st.openclaw.hasToken ? (st.openclaw.fromConfig ? 'The hook token comes from ~/.openclaw/openclaw.json.' : 'Uses the hook token you entered.') : 'Needs hooks.enabled and hooks.token in ~/.openclaw/openclaw.json, or the token below.'}`, toggle(st.sendTo.openclaw, (v) => set({ sendTo: { openclaw: v } }), 'Send pages to OpenClaw')),
    );
    if (st.sendTo.openclaw) {
      const url = h('input', { class: 'input', style: { width: '240px' }, placeholder: 'http://127.0.0.1:18789', value: st.openclaw.url, 'aria-label': 'OpenClaw gateway address' });
      url.addEventListener('change', () => set({ openclawUrl: url.value }).catch((e) => window.alert(e.message)));
      const token = h('input', { class: 'input', type: 'password', style: { width: '240px' }, placeholder: st.openclaw.fromConfig ? 'From openclaw.json' : 'Hook token', autocomplete: 'off', 'aria-label': 'OpenClaw hook token' });
      token.addEventListener('change', () => set({ openclawToken: token.value }));
      const out = h('div', { class: 'stack ag-out' });
      card.append(
        setting('OpenClaw gateway', 'Leave empty for the one in openclaw.json (127.0.0.1:18789 by default).', url),
        setting('OpenClaw hook token', 'Kept in this browser profile only. Leave empty to read it from openclaw.json.', token),
        h('div', { class: 'setting' }, h('div', { class: 'grow' }, h('div', {}, 'Test the connection'), h('div', { class: 'd' }, 'Sends OpenClaw a short test message.'), out), h('button', { class: 'btn', onclick: async () => { clear(out); const r = await call('send.test-openclaw'); out.append(h('div', { class: r.ok ? '' : 'muted' }, r.ok ? '✓ OpenClaw accepted the message.' : r.error)); } }, 'Test')),
      );
    }
    card.append(setting('Snapshot folder', `Snapshots are saved in ${st.folder} for the app to read, and deleted after a week.`, h('button', { class: 'btn', onclick: () => call('send.open-folder') }, 'Open folder')));
  };
  const refresh = () => call('send.state').then(render, (e) => {
    clear(card);
    card.append(h('div', { class: 'setting muted' }, `Unavailable: ${e.message}`));
  });
  refresh();
  return [h('h2', { id: 'send-to-ai' }, 'Send pages to AI apps'), card];
}
