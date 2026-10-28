// Error panel shown over a tab whose page failed to load (network/DNS, certificate, crash).
import { icon, h, clear } from './icons.js';

const root = document.getElementById('root');

const NET_HINTS = {
  '-105': { title: 'This site can’t be reached', why: (host) => `${host}’s server IP address could not be found.`, tips: ['Check the address for typos', 'Check your internet connection', 'Check your DNS / proxy settings'] },
  '-106': { title: 'No internet', why: () => 'Your device is not connected to the internet.', tips: ['Check network cables, modem and router', 'Reconnect to Wi-Fi'] },
  '-102': { title: 'This site can’t be reached', why: (host) => `${host} refused to connect.`, tips: ['Check that the server is running', 'Check the port number'] },
  '-118': { title: 'This site can’t be reached', why: (host) => `${host} took too long to respond.`, tips: ['Check your internet connection', 'Try again later'] },
  '-109': { title: 'This site can’t be reached', why: (host) => `${host} is unreachable.`, tips: ['Check your internet connection'] },
  '-137': { title: 'This site can’t be reached', why: (host) => `${host}’s DNS lookup failed.`, tips: ['Check your DNS settings'] },
  '-300': { title: 'Invalid address', why: () => 'The address is not valid.', tips: [] },
  '-301': { title: 'Can’t open this address', why: () => 'The browser doesn’t know how to open this kind of address.', tips: [] },
  '-310': { title: 'This page isn’t working', why: (host) => `${host} redirected you too many times.`, tips: ['Try clearing cookies for this site'] },
  '-6': { title: 'File not found', why: () => 'The file may have been moved or deleted.', tips: [] },
  '-20': { title: 'Blocked', why: () => 'This page was blocked.', tips: [] },
  '-21': { title: 'Your connection was interrupted', why: () => 'A network change was detected.', tips: [] },
  '-101': { title: 'This site can’t be reached', why: (host) => `The connection to ${host} was reset.`, tips: ['Check your internet connection', 'Check any proxy, firewall or VPN'] },
  '-100': { title: 'This site can’t be reached', why: (host) => `${host} unexpectedly closed the connection.`, tips: [] },
};

function hostOf(url) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function render({ tabId, error, theme }) {
  document.documentElement.dataset.theme = theme;
  clear(root);
  const act = (action) => window.lw.call('panel.action', { tabId, action });
  const host = hostOf(error.url || '');
  if (error.kind === 'cert') {
    const details = h('details', { class: 'details' }, h('summary', {}, 'Advanced'), h('p', {}, `${host} presented a certificate that is not trusted: ${error.description}. Attackers might be trying to steal your information (passwords, messages or credit cards).`), h('div', { class: 'mono' }, `Issuer: ${error.issuer || '—'}`), h('div', { class: 'mono' }, `Subject: ${error.subject || '—'}`), h('div', { class: 'mono' }, `Fingerprint: ${error.fingerprint || '—'}`), h('p', {}, h('button', { class: 'link', onclick: () => act('proceed') }, `Continue to ${host} (unsafe)`)));
    root.append(
      h('div', { class: 'art danger' }, icon('warn', { size: 36 })),
      h('h1', {}, 'Your connection isn’t private'),
      h('p', {}, `Attackers might be trying to steal your information from ${host}.`),
      h('div', { class: 'code' }, String(error.description || '')),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => act('back') }, 'Go back to safety')),
      details,
    );
    return;
  }
  if (error.kind === 'crash') {
    root.append(h('div', { class: 'art' }, icon('warn', { size: 36 })), h('h1', {}, 'Aw, this page crashed'), h('p', {}, 'Something went wrong while displaying this page.'), h('div', { class: 'code' }, String(error.code || '')), h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => act('retry') }, 'Reload')));
    return;
  }
  const hint = NET_HINTS[String(error.code)] || { title: 'This page isn’t available', why: () => `${host} could not be loaded.`, tips: [] };
  root.append(
    h('div', { class: 'art' }, icon('globe', { size: 36 })),
    h('h1', {}, hint.title),
    h('p', {}, hint.why(host)),
    hint.tips.length ? h('ul', {}, ...hint.tips.map((t) => h('li', {}, t))) : null,
    h('div', { class: 'code' }, String(error.description || error.code || '')),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => act('retry') }, 'Try again'), String(error.code) === '-105' ? h('button', { class: 'btn', onclick: () => act('search') }, 'Search instead') : null),
  );
}

window.lw.on('panel', render);
window.lw.on('theme', (t) => {
  document.documentElement.dataset.theme = t;
});
