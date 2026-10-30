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
