// "Send to AI" popup (src/main/agent/send.js), rendered by overlay.js:
//   send-ai   pick an AI app, what to send (address or snapshot), what it should do, and whether it may
//             control the page — answered with popup.action send {harness, mode, narrative, control}
import { icon, h, clear } from './icons.js';

if (!document.querySelector('link[data-send]')) {
  document.head.append(h('link', { rel: 'stylesheet', href: 'overlay-send.css', 'data-send': '1' }));
}

const MARK = { vision: 'V', openclaw: 'O', claude: 'C', 'claude-code': '>_' };

export const POPUPS = {
  'send-ai'(data, _ctx, { act, close }) {
    const box = h('div', { class: 'popup send-ai' });
    const st = { harness: data.last.harness, mode: data.last.mode, control: data.last.control, busy: false };
    let host = data.page.url;
    try {
      host = new URL(data.page.url).host || data.page.url;
    } catch {
      /* keep */
    }

    const apps = h('div', { class: 'sa-apps', role: 'radiogroup', 'aria-label': 'AI app' });
    const drawApps = () => {
      clear(apps);
      for (const a of data.harnesses) {
        const b = h('button', { class: `sa-app ${st.harness === a.id ? 'sel' : ''} ${a.ready ? '' : 'off'}`, role: 'radio', 'aria-checked': String(st.harness === a.id), title: a.note, dataset: { id: a.id } }, h('span', { class: `sa-mark m-${a.id}` }, MARK[a.id] || a.name[0]), h('span', { class: 'sa-name' }, a.name));
        b.addEventListener('click', () => {
          st.harness = a.id;
          drawApps();
          drawNote();
        });
        apps.append(b);
      }
    };

    const modeRow = h('div', { class: 'sa-modes', role: 'radiogroup', 'aria-label': 'What to send' });
    const drawModes = () => {
      clear(modeRow);
      for (const [m, label, sub] of [
        ['url', 'Page address', 'Just the link'],
        ['snapshot', 'Snapshot', 'HTML, CSS, JS + screenshot'],
      ]) {
        const b = h('button', { class: `sa-mode ${st.mode === m ? 'sel' : ''}`, role: 'radio', 'aria-checked': String(st.mode === m) }, h('span', { class: 't' }, label), h('span', { class: 's' }, sub));
        b.addEventListener('click', () => {
          st.mode = m;
          drawModes();
          drawNote();
        });
        modeRow.append(b);
      }
    };

    const narrative = h('textarea', { class: 'input sa-text', rows: 4, placeholder: 'What should it do with this page? e.g. “Summarize this and list the action items”, “Fill in this form with…”, “Why does this layout break on mobile?”', 'aria-label': 'What should the AI app do with this page' });
    narrative.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        send();
      }
    });
    const ctlBox = h('input', { type: 'checkbox', checked: st.control });
    ctlBox.addEventListener('change', () => {
      st.control = ctlBox.checked;
      drawNote();
    });
    const note = h('div', { class: 'sa-note' });
    const appName = () => (data.harnesses.find((x) => x.id === st.harness) || {}).name || 'it';
    const drawNote = () => {
      const a = data.harnesses.find((x) => x.id === st.harness);
      const lines = [];
      if (a && !a.ready) lines.push(a.note);
      if (st.mode === 'snapshot' && st.harness === 'claude') lines.push('The screenshot goes on the clipboard for you to paste: Claude chat cannot read files on this computer.');
      if (st.control) lines.push(`${appName()} will be able to read this page, click and type in it. The window glows while it does; stop it any time.${data.agentOn ? '' : ' This turns on AI agent access.'}`);
      note.textContent = lines.join(' ');
      note.hidden = !lines.length;
      sendBtn.disabled = st.busy || !a || !a.ready;
      sendBtn.lastChild.textContent = `Send to ${appName()}`;
    };
    const result = h('div', { class: 'sa-result', hidden: true, role: 'status' });
    const sendBtn = h('button', { class: 'btn primary' }, icon('send', { size: 15 }), h('span', {}, 'Send'));
    const send = async () => {
      if (sendBtn.disabled) return;
      st.busy = true;
      sendBtn.disabled = true;
      sendBtn.lastChild.textContent = st.mode === 'snapshot' ? 'Taking the snapshot…' : 'Sending…';
      const r = await act('send', { harness: st.harness, mode: st.mode, control: st.control, narrative: narrative.value }).catch((e) => ({ ok: false, message: e.message }));
      st.busy = false;
      result.hidden = false;
      result.className = `sa-result ${r && r.ok ? 'ok' : 'err'}`;
      clear(result).append(icon(r && r.ok ? 'check' : 'warn', { size: 16 }), h('span', {}, (r && r.message) || 'Something went wrong.'));
      drawNote();
      if (r && r.ok) {
        sendBtn.lastChild.textContent = 'Sent';
        sendBtn.disabled = true;
        setTimeout(close, 3500);
      }
    };
    sendBtn.addEventListener('click', send);

    const c = data.control;
    const controlling = c
      ? h(
          'div',
          { class: 'sa-controlled' },
          h('span', { class: 'cb-dot' }),
          h('span', { class: 'grow' }, c.waiting ? `${c.client} may control this page (not connected yet)` : `${c.client} controls this page`),
          h('button', {
            class: 'btn small',
            onclick: async (e) => {
              await act('stop-control', {});
              e.currentTarget.closest('.sa-controlled').remove();
            },
          }, 'Stop'),
        )
      : null;

    box.append(
      h('div', { class: 'head' }, h('span', { class: 'sa-ic' }, icon('send', { size: 18 })), h('div', { class: 'grow' }, h('h2', {}, 'Send to AI'), h('div', { class: 'sub sa-page', title: data.page.url }, data.page.title || host, h('span', { class: 'sa-host' }, ` · ${host}`)))),
      ...(controlling ? [controlling] : []),
      h('div', { class: 'pad stack sa-body' }, apps, modeRow, narrative, h('label', { class: 'check sa-check' }, ctlBox, h('span', {}, 'Let it control this page (click, type, navigate)')), note, result),
      h('div', { class: 'foot sa-foot' }, h('button', { class: 'btn ghost', onclick: () => act('settings', {}) }, 'Settings'), h('span', { class: 'grow' }), sendBtn),
    );
    drawApps();
    drawModes();
    drawNote();
    setTimeout(() => narrative.focus(), 30);
    return box;
  },
};
