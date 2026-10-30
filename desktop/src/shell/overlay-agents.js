// AI agents popups (src/main/agent/agent.js), rendered by overlay.js:
//   agents          the toolbar menu: connected agents, what they are doing, Stop / Resume / Disconnect
//   agent-approve   modal question: let an agent in (connect), fill a saved password for it (login), or
//                   share the current tab with it (share) — answered with prompt.answer {decision, account}
import { icon, h, clear } from './icons.js';

if (!document.querySelector('link[data-agents]')) {
  document.head.append(h('link', { rel: 'stylesheet', href: 'overlay-agents.css', 'data-agents': '1' }));
}

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

export const POPUPS = {
  agents(data, ctx, { act }) {
    const box = h('div', { class: 'popup ag-menu' });
    const run = async (action, d) => {
      const r = await act(action, d || {});
      if (r) render(r);
    };
    const render = (d) => {
      clear(box);
      box.append(h('div', { class: 'head' }, h('span', { class: 'ag-ic' }, icon('bot', { size: 18 })), h('div', { class: 'grow' }, h('h2', {}, 'AI agents'), h('div', { class: 'sub' }, d.sessions.length ? `${d.sessions.length} connected` : 'None connected'))));
      const list = h('div', { class: 'list ag-list' });
      if (!d.sessions.length) list.append(h('div', { class: 'pad muted' }, 'Agents you allow (Claude Code, Vision, other MCP clients) show up here while they use the browser.'));
      for (const s of d.sessions) {
        const status = s.stopped ? 'Stopped by you' : s.busy ? `Working${s.lastTool ? ` · ${s.lastTool.replace(/^browser_/, '')}` : ''}` : `Idle · last action ${ago(s.lastUsed)}`;
        list.append(
          h(
            'div',
            { class: `item ag-row ${s.busy ? 'busy' : ''} ${s.stopped ? 'stopped' : ''}` },
            h('span', { class: 'ic' }, h('span', { class: 'ag-dot' })),
            h('span', { class: 'grow' }, h('div', { class: 't' }, s.client, s.label ? h('span', { class: 'ag-label' }, ` · ${s.label}`) : null), h('div', { class: 's' }, `${status} · ${s.tabs} tab${s.tabs === 1 ? '' : 's'} · ${s.calls} action${s.calls === 1 ? '' : 's'}`)),
            h('div', { class: 'ag-actions' }, s.stopped ? h('button', { class: 'btn small primary', onclick: () => run('resume', { key: s.key }) }, 'Resume') : h('button', { class: 'btn small', onclick: () => run('stop', { key: s.key }) }, 'Stop'), s.tabs ? h('button', { class: 'icon-btn small', title: 'Show its window', 'aria-label': 'Show its window', onclick: () => run('show', { key: s.key }) }, icon('external', { size: 14 })) : null, h('button', { class: 'icon-btn small', title: 'Disconnect (its tabs stay open)', 'aria-label': 'Disconnect', onclick: () => run('disconnect', { key: s.key }) }, icon('close', { size: 14 }))),
          ),
        );
      }
      box.append(list);
      box.append(
        h(
          'div',
          { class: 'pad row end ag-foot' },
          h('button', { class: 'btn', onclick: () => act('settings', {}) }, 'Settings'),
          d.sessions.some((s) => !s.stopped) ? h('button', { class: 'btn', onclick: () => run('stop-all', {}) }, 'Stop all') : null,
          h('button', { class: 'btn danger', onclick: () => act('turn-off', {}) }, 'Turn off'),
        ),
      );
    };
    ctx.onData = render;
    render(data);
    return box;
  },

  'agent-approve'(data, _ctx, { call }) {
    const answer = (decision, extra = {}) => call('prompt.answer', { id: data.promptId, value: { decision, ...extra } });
    const client = data.client || 'An agent';
    let title;
    let lines;
    let buttons;
    let account = data.accounts && data.accounts[0] ? data.accounts[0].id : null;
    const body = h('div', { class: 'pad stack' });
    if (data.kind === 'login') {
      title = `Sign in to ${data.host} for ${client}?`;
      lines = [`The browser fills your saved password${(data.accounts || []).length > 1 ? ' for the account you choose' : ''}. ${client} never sees it.`];
      buttons = [
        ['deny', 'Don’t allow'],
        ['once', 'Allow once'],
        ['always', `Always for ${data.host}`],
      ];
    } else if (data.kind === 'share') {
      title = `Share this tab with ${client}?`;
      lines = [`“${data.title || data.host}” (${data.host})`, `${client} will be able to read this page, click and type in it.`];
      buttons = [
        ['deny', 'Don’t share'],
        ['once', 'Share'],
      ];
    } else {
      title = `Let ${client} use Ludworks Browser?`;
      lines = [
        `${client}, an AI agent on this computer, wants to open web pages in a window of its own, read them, click and type, and take screenshots — with your signed-in sites.`,
        'It never sees your passwords, private windows or the browser’s own pages. You can watch it, and stop it from the toolbar at any time.',
      ];
      if (data.turnOn) lines.push('This turns on AI agent access (Settings → AI agents).');
      buttons = [
        ['deny', 'Don’t allow'],
        ['once', 'Allow this time'],
        ['always', `Always allow ${client}`],
      ];
    }
    for (const l of lines) body.append(h('div', {}, l));
    if (data.kind === 'login' && (data.accounts || []).length) {
      const list = h('div', { class: 'ag-accounts' });
      data.accounts.forEach((a, i) => {
        const radio = h('input', { type: 'radio', name: 'ag-account', value: a.id, checked: i === 0 });
        radio.addEventListener('change', () => {
          if (radio.checked) account = a.id;
        });
        list.append(h('label', { class: 'check' }, radio, h('span', { class: 'grow' }, h('div', { class: 't' }, a.username || '(no username)'), a.name ? h('div', { class: 's' }, a.name) : null)));
      });
      body.append(list);
    }
    const btns = buttons.map(([d, label], i) => h('button', { class: `btn ${i === buttons.length - 1 ? 'primary' : ''}`, onclick: () => answer(d, account ? { account } : {}) }, label));
    setTimeout(() => btns[btns.length - 1].focus(), 30);
    return h(
      'div',
      { class: 'popup ag-approve', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'head' }, h('span', { class: 'ag-ic big' }, icon(data.kind === 'login' ? 'key' : 'bot', { size: 22 })), h('div', { class: 'grow' }, h('h2', {}, title))),
      body,
      h('div', { class: 'foot' }, ...btns),
    );
  },
};
