// New tab page: search, most visited sites, and shortcuts into the user's Ludworks server.
import { h, clear, applyTheme } from './ui.js';

const q = document.getElementById('q');

async function load() {
  const d = await window.lwPage.call('newtab.data');
  applyTheme(d.theme);
  chromeTheme(d.chromeTheme);
  q.placeholder = `Search ${d.engine} or type a URL`;
  if (d.private) {
    document.body.classList.add('private');
    document.querySelector('.hero').append(h('div', { class: 'private-note' }, 'Private window — pages you visit here are not saved in history, and cookies and site data are deleted when you close your last private window. Downloads and bookmarks you create are kept.'));
  }
  const sites = document.getElementById('sites');
  clear(sites);
  for (const s of d.topSites) {
    let host = s.url;
    try {
      host = new URL(s.url).hostname.replace(/^www\./, '');
    } catch {
      /* keep url */
    }
    const a = h('a', { class: 'site', href: s.url, title: `${s.title || host}\n${s.url}` }, h('span', { class: 'tile' }, (host[0] || '?').toUpperCase()), h('span', { class: 'name' }, s.title || host));
    sites.append(a);
  }
  const lw = document.getElementById('ludworks');
  if (d.server) {
    lw.hidden = false;
    clear(lw);
    lw.classList.add('card');
    const apps = [['Files', '/files'], ['TV', '/tv'], ['Music', '/music'], ['Notes', '/notes'], ['Passwords', '/vault'], ['Sheets', '/sheets'], ['Boards', '/kanban']];
    lw.append(h('h2', {}, h('img', { src: '/assets/logo.svg', width: 16, height: 16, alt: '' }), `Your Ludworks — ${new URL(d.server).host}`), h('div', { class: 'apps' }, ...apps.map(([name, p]) => h('a', { href: new URL(p, d.server).href }, name))));
  } else lw.hidden = true;
}

/** A Chrome theme's new tab page: background colour and image (aligned and repeated as it says), text colours. */
function chromeTheme(t) {
  const s = document.documentElement.style;
  document.body.classList.toggle('themed', !!t);
  for (const k of ['--ntp-bg', '--ntp-text', '--ntp-link', '--ntp-img', '--ntp-pos', '--ntp-repeat', '--ntp-attr']) s.removeProperty(k);
  if (!t) return;
  for (const k of ['--ntp-bg', '--ntp-text', '--ntp-link']) if (t.vars[k]) s.setProperty(k, t.vars[k]);
  const url = (u) => `url("${String(u).replace(/["\\]/g, '')}")`;
  if (t.images.ntpBackground) {
    s.setProperty('--ntp-img', url(t.images.ntpBackground));
    s.setProperty('--ntp-pos', t.ntp.position);
    s.setProperty('--ntp-repeat', t.ntp.repeat);
  }
  if (t.images.ntpAttribution) s.setProperty('--ntp-attr', url(t.images.ntpAttribution));
}
window.lwPage.on('page-event', (ev) => {
  if (ev && ev.type === 'theme') load();
});

document.getElementById('search').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = q.value.trim();
  if (text) window.lwPage.call('newtab.go', { text });
});

load();
// The keyboard starts in the address bar (Browser.newTabWithOmnibox); this search box takes it on a click.
