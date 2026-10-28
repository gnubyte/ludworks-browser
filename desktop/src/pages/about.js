// About: versions, engine, DRM component status, licences.
import { h, clear, applyTheme, sideNav } from './ui.js';

const app = document.getElementById('app');
const main = h('main', { class: 'main' });
app.append(sideNav('about'), main);

(async () => {
  const a = await window.lwPage.call('about');
  applyTheme(a.theme);
  clear(main);
  const row = (k, v) => h('div', { class: 'setting' }, h('div', { class: 'grow' }, k), h('div', { class: 'muted', style: { fontFamily: 'ui-monospace, Consolas, monospace' } }, v));
  const drm = a.drm && !a.drm.error ? Object.values(a.drm).map((c) => `${c.title} ${c.version} (${c.status})`).join(', ') : a.drm && a.drm.error ? `unavailable: ${a.drm.error}` : 'starting…';
  main.append(
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '18px', marginBottom: '20px' } }, h('img', { src: '/assets/logo.svg', width: 72, height: 72, alt: '' }), h('div', {}, h('h1', { style: { margin: 0 } }, 'Ludworks Browser'), h('div', { class: 'muted' }, `Version ${a.version}`))),
    h('div', { class: 'card' }, row('Chromium', a.chrome), row('Electron (castlabs, Widevine)', a.electron), row('Node.js', a.node), row('V8', a.v8), row('Platform', a.platform), row('Widevine CDM', drm), row('Profile', a.profile)),
    h('p', { class: 'muted', style: { marginTop: '18px' } }, 'Ludworks Browser is built on Chromium (BSD licence) via Electron for Content Security by castlabs. The Chromium licence texts ship in LICENSES.chromium.html.gz next to the program.'),
  );
})();
