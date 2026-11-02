// Sending a page to an AI app (src/main/agent/handoff.js): enabled apps, the prompt, Claude links, OpenClaw
// config and requests, Vision launch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HARNESSES, enabledHarnesses, validSendTo, handoffDirName, handoffPrompt, claudeLink, CLAUDE_PROMPT_MAX, parseJson5, openclawHookConfig, openclawRequest, openclawError, visionCandidates, visionLaunch } from '../build/app/main/agent/handoff.js';

test('handoff: apps the user turned on, Claude covers chat and Claude Code', () => {
  assert.deepEqual(enabledHarnesses(undefined), []);
  assert.deepEqual(enabledHarnesses({ vision: true }), ['vision']);
  assert.deepEqual(enabledHarnesses({ claude: true, openclaw: true }), ['openclaw', 'claude', 'claude-code']);
  assert.deepEqual(enabledHarnesses({ vision: 'yes' }), []);
  assert.ok(validSendTo({ vision: true, claude: false }));
  assert.ok(!validSendTo({ other: true }));
  assert.ok(!validSendTo({ vision: 1 }));
  assert.ok(!validSendTo([]));
  for (const h of Object.values(HARNESSES)) assert.ok(h.clients.includes(h.name));
});

test('handoff: folder names are sortable and safe', () => {
  const d = new Date(2026, 10, 2, 9, 5, 7);
  assert.equal(handoffDirName(d, 'https://www.example.com/a?b'), '2026-11-02 090507 example.com');
  assert.equal(handoffDirName(d, 'file:///C:/x.html'), '2026-11-02 090507 page');
  assert.equal(handoffDirName(d, 'not a url'), '2026-11-02 090507 page');
});

test('handoff: the prompt carries the ask, the page, the snapshot files and how to control the page', () => {
  const page = { title: 'Orders', url: 'https://shop.example/orders' };
  const plain = handoffPrompt({ page });
  assert.match(plain, /^Take a look at this web page/);
  assert.match(plain, /“Orders” https:\/\/shop\.example\/orders/);
  assert.doesNotMatch(plain, /snapshot|control/i);

  const snap = { dir: '/tmp/h/x', screenshot: '/tmp/h/x/screenshot.png', html: '/tmp/h/x/page.html', assets: '/tmp/h/x/page_files', text: '/tmp/h/x/page.txt' };
  const full = handoffPrompt({ narrative: '  List the late orders  ', page, snapshot: snap, control: { tabId: 42, client: 'Vision', cli: '/opt/lwb', mcp: true } });
  assert.match(full, /^List the late orders\n/);
  assert.match(full, /in this folder: \/tmp\/h\/x/);
  assert.match(full, /screenshot\.png: screenshot/);
  assert.match(full, /page\.html and page_files\/: the page's HTML with its CSS, JavaScript and images/);
  assert.match(full, /tab 42, already shared with you/);
  assert.match(full, /ludworks-browser tools/);
  assert.match(full, /"\/opt\/lwb" --client="Vision" browser_snapshot/);

  // Claude chat cannot read local files: no folder, the screenshot is on the clipboard
  const chat = handoffPrompt({ page, snapshot: snap, local: false, imageOnClipboard: true });
  assert.doesNotMatch(chat, /\/tmp\/h/);
  const chat2 = handoffPrompt({ page, local: false, imageOnClipboard: true });
  assert.match(chat2, /on the clipboard/);
  // OpenClaw: no MCP tools, only the command line
  const oc = handoffPrompt({ page, control: { tabId: 7, client: 'OpenClaw', cli: 'C:\\lwb.exe', mcp: false } });
  assert.doesNotMatch(oc, /ludworks-browser tools/);
  assert.match(oc, /Use the browser's command line: "C:\\lwb\.exe" --client="OpenClaw"/);
});

test('handoff: Claude links prefill a chat or a Claude Code session and stay within the prompt limit', () => {
  assert.equal(claudeLink('claude', 'Hi & bye?'), 'claude://claude.ai/new?q=Hi%20%26%20bye%3F');
  assert.equal(claudeLink('claude-code', 'Fix it', '/tmp/my dir'), 'claude://code/new?q=Fix%20it&folder=%2Ftmp%2Fmy%20dir');
  assert.equal(claudeLink('claude-code', 'x'), 'claude://code/new?q=x');
  const long = claudeLink('claude', 'a'.repeat(20000));
  assert.equal(decodeURIComponent(long.split('q=')[1]).length, CLAUDE_PROMPT_MAX);
});

test('handoff: JSON5 config with comments, bare keys, single quotes and trailing commas', () => {
  const cfg = parseJson5(`{
    // OpenClaw config
    gateway: { port: 18800, bind: 'loopback', },
    /* hooks */
    hooks: { enabled: true, token: 'abc"d//e', path: "/hooks", allowedAgentIds: ["main",], },
    url: "http://x/y", // not a comment inside the string
  }`);
  assert.deepEqual(cfg, { gateway: { port: 18800, bind: 'loopback' }, hooks: { enabled: true, token: 'abc"d//e', path: '/hooks', allowedAgentIds: ['main'] }, url: 'http://x/y' });
  assert.equal(parseJson5('{ nope'), null);
  assert.equal(parseJson5(''), null);
});

test('handoff: OpenClaw hook address and token come from its config, the address can be overridden', () => {
  assert.deepEqual(openclawHookConfig(''), { url: 'http://127.0.0.1:18789/hooks/agent', token: '', enabled: false });
  assert.deepEqual(openclawHookConfig('{ gateway: { port: 19000 }, hooks: { enabled: true, token: "t1", path: "/in/" } }'), { url: 'http://127.0.0.1:19000/in/agent', token: 't1', enabled: true });
  assert.equal(openclawHookConfig('{ hooks: { path: "/" } }', { baseUrl: 'http://box:1234/' }).url, 'http://box:1234/hooks/agent');
  const r = openclawRequest({ url: 'http://127.0.0.1:18789/hooks/agent', token: 'tok', message: 'hello', idempotencyKey: 'k1' });
  assert.equal(r.headers.Authorization, 'Bearer tok');
  assert.equal(r.headers['Idempotency-Key'], 'k1');
  assert.deepEqual(JSON.parse(r.body), { message: 'hello', name: 'Ludworks Browser' });
  assert.ok(JSON.parse(openclawRequest({ url: 'u', token: 't', message: 'x'.repeat(300 * 1024) }).body).message.length <= 200 * 1024);
  assert.match(openclawError(401), /hook token/);
  assert.match(openclawError(404), /hooks\.enabled/);
  assert.match(openclawError(500, '  boom \n bad '), /answered 500: boom bad/);
});

test('handoff: where Vision lives and how it is started', () => {
  const win = visionCandidates({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', ProgramFiles: 'C:\\Program Files' } });
  assert.deepEqual(win, ['C:\\Users\\u\\AppData\\Local\\Programs\\Vision\\Vision.exe', 'C:\\Program Files\\Vision\\Vision.exe']);
  assert.deepEqual(visionCandidates({ platform: 'darwin', home: '/Users/u' }), ['/Applications/Vision.app', '/Users/u/Applications/Vision.app']);
  assert.deepEqual(visionCandidates({ platform: 'linux' }), []);
  assert.deepEqual(visionLaunch('C:\\V\\Vision.exe', 'C:\\h', 'C:\\h\\request.json', 'win32'), { file: 'C:\\V\\Vision.exe', args: ['C:\\h', '--ludworks-request=C:\\h\\request.json'] });
  assert.deepEqual(visionLaunch('/Applications/Vision.app', '/h', '/h/request.json', 'darwin'), { file: 'open', args: ['-a', '/Applications/Vision.app', '--args', '/h', '--ludworks-request=/h/request.json'] });
});
