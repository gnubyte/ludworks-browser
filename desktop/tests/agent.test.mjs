// AI agents (src/main/agent): the tool registry and argument coercion, accessibility snapshots, key chords,
// MCP, the agent server's request checks, harness setup (Vision templates, Claude settings) and set-of-marks.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toolList, coerceArgs, canonicalToolName, catalog, ArgError, TOOL_NAMES } from '../build/app/main/agent/tools.js';
import { RefMap, buildSnapshot, formatSnapshot, findInSnapshot } from '../build/app/main/agent/snapshot.js';
import { parseChord, keyEvents, modifierEvents, modifierMask, KeyError } from '../build/app/main/agent/keys.js';
import { handleMessage, negotiateVersion, expectsResponse, initializeClientName } from '../build/app/main/agent/mcp.js';
import { AgentServer, HttpError, writeEndpoint, removeEndpoint, cleanHeader, ENDPOINT_FILE } from '../build/app/main/agent/server.js';
import { visionCommand, visionManifest, visionShell, visionPaths, skillMarkdown, allowInClaudeSettings, mcpStdioConfig, claudeAddArgs, claudeDesktopConfigPaths, addMcpServer } from '../build/app/main/agent/integrations.js';
import { drawMarks, labelSize } from '../build/app/main/agent/annotate.js';

// ------------------------------------------------------------------------------------- tools
test('agent tools: every tool has a schema, the browser_ prefix and an object input', () => {
  const list = toolList();
  assert.equal(list.length, TOOL_NAMES.length);
  for (const t of list) {
    assert.match(t.name, /^browser_[a-z_]+$/);
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(t.description.length > 20 && t.description.length < 400, t.name);
    for (const r of t.inputSchema.required || []) assert.ok(t.inputSchema.properties[r], `${t.name}.${r}`);
  }
  assert.equal(canonicalToolName('navigate'), 'browser_navigate');
  assert.equal(canonicalToolName('browser_click'), 'browser_click');
  assert.equal(canonicalToolName('nope'), null);
  const c = catalog('1.2.3');
  assert.equal(c.serverInfo.version, '1.2.3');
  assert.match(c.instructions, /untrusted/);
});

test('agent tools: the lwb CLI embeds the current catalog', () => {
  const embedded = JSON.parse(readFileSync(new URL('../tools/lwb/tools.json', import.meta.url), 'utf8'));
  const current = catalog(embedded.serverInfo.version);
  assert.deepEqual(embedded.tools, current.tools, 'desktop/tools/lwb/tools.json is stale: run node desktop/build.mjs lwb');
  assert.equal(embedded.instructions, current.instructions, 'desktop/tools/lwb/tools.json is stale: run node desktop/build.mjs lwb');
});

test('agent tools: shell-style string arguments are converted to the schema', () => {
  assert.deepEqual(coerceArgs('browser_click', { ref: 'e5', x: '', double: 'true', modifiers: 'Control+Shift' }), { ref: 'e5', double: true, modifiers: ['Control', 'Shift'] });
  assert.deepEqual(coerceArgs('browser_click', { x: '12.5', y: 30, button: 'RIGHT' }), { x: 12.5, y: 30, button: 'right' });
  assert.deepEqual(coerceArgs('browser_snapshot', { max_chars: '5000.9', filter: 'interactive', unknown: 'x' }), { max_chars: 5000, filter: 'interactive' });
  // arrays of objects arrive as JSON text from shell templates
  const ff = coerceArgs('browser_fill_form', { fields: '[{"ref":"e1","value":"a"},{"ref":"e2","value":true}]' });
  assert.deepEqual(ff.fields, [{ ref: 'e1', value: 'a' }, { ref: 'e2', value: true }]);
  assert.deepEqual(coerceArgs('browser_file_upload', { ref: 'e3', paths: 'C:\\a.txt' }).paths, ['C:\\a.txt']);
  assert.deepEqual(coerceArgs('browser_select_option', { ref: 'e3', values: '["A", "B"]' }).values, ['A', 'B']);
  assert.throws(() => coerceArgs('browser_navigate', {}), ArgError);
  assert.throws(() => coerceArgs('browser_click', { x: 'left' }), /number/);
  assert.throws(() => coerceArgs('browser_click', { double: 'maybe' }), /true or false/);
  assert.throws(() => coerceArgs('browser_click', { button: 'side' }), /one of/);
  assert.throws(() => coerceArgs('browser_fill_form', { fields: '[{"value":1}]' }), /ref is required/);
  assert.throws(() => coerceArgs('browser_batch', { actions: 'not json' }), /JSON array/);
});

// ---------------------------------------------------------------------------------- snapshot
let nid = 0;
function ax(role, name, { children = [], backend, props = {}, value, ignored = false } = {}) {
  const id = String(++nid);
  return { id, role, name, children, backend, props, value, ignored };
}
function flatten(root) {
  const out = [];
  const walk = (n, parent) => {
    out.push({
      nodeId: n.id,
      parentId: parent,
      ignored: n.ignored,
      role: { type: 'role', value: n.role },
      name: n.name !== undefined ? { type: 'computedString', value: n.name } : undefined,
      value: n.value !== undefined ? { type: 'string', value: n.value } : undefined,
      properties: Object.entries(n.props).map(([k, v]) => ({ name: k, value: { type: 'booleanOrUndefined', value: v } })),
      childIds: n.children.map((c) => c.id),
      backendDOMNodeId: n.backend,
    });
    for (const c of n.children) walk(c, n.id);
  };
  walk(root, undefined);
  return out;
}

function page() {
  return ax('RootWebArea', 'Sign in — Example', {
    backend: 1,
    children: [
      ax('heading', 'Sign in', { backend: 2, props: { level: 1 }, children: [ax('StaticText', 'Sign in')] }),
      ax('generic', '', {
        backend: 3,
        children: [
          ax('paragraph', '', { backend: 4, children: [ax('StaticText', 'Use your'), ax('strong', '', { children: [ax('StaticText', 'Example')] }), ax('StaticText', 'account.')] }),
          ax('textbox', 'Email', { backend: 5, props: { required: true, focused: true }, value: 'ada@example.com' }),
          ax('textbox', 'Password', { backend: 6, value: '••••••' }),
          ax('checkbox', 'Remember me', { backend: 7, props: { checked: 'true' } }),
          ax('button', 'Continue', { backend: 8, children: [ax('StaticText', 'Continue')] }),
          ax('link', 'Forgot password?', { backend: 9, props: { url: 'https://example.com/reset?x=1' } }),
          ax('generic', '', { backend: 10, children: [ax('StaticText', 'Add to cart')] }),
          ax('Iframe', 'Captcha', { backend: 11 }),
        ],
      }),
      ax('InlineTextBox', 'x', { backend: 99 }),
    ],
  });
}
function frameDoc() {
  return ax('RootWebArea', 'captcha', { backend: 1, children: [ax('checkbox', "I'm not a robot", { backend: 2 })] });
}

test('agent snapshot: compact outline with stable refs, states, values, links and frames', () => {
  const refs = new RefMap();
  const extras = new Map([['|10', { clickable: true }], ['|6', { password: true }]]);
  const frames = [
    { key: '|main', session: '', nodes: flatten(page()), parentSession: null, ownerBackendId: null },
    { key: 'S1|f2', session: 'S1', nodes: flatten(frameDoc()), parentSession: '', ownerBackendId: 11 },
  ];
  const snap = buildSnapshot({ frames, refs, extras, pageUrl: 'https://example.com/login' });
  const text = formatSnapshot(snap).text;
  assert.equal(snap.title, 'Sign in — Example');
  assert.match(text, /^- heading "Sign in" \[level=1\] \[ref=e1\]$/m);
  assert.match(text, /^- paragraph: Use your Example account\.$/m);
  assert.match(text, /^- textbox "Email" \[required\] \[focused\] \[ref=e\d+\] value="ada@example\.com"$/m);
  assert.match(text, /- textbox "Password" \[ref=e\d+\] value="••••••"/);
  assert.match(text, /- checkbox "Remember me" \[checked\] \[ref=e\d+\]/);
  assert.match(text, /- button "Continue" \[ref=e\d+\]$/m);
  assert.match(text, /- link "Forgot password\?" \[ref=e\d+\] → \/reset\?x=1/);
  assert.match(text, /- clickable "Add to cart" \[ref=e\d+\]$/m);
  assert.match(text, /- iframe "Captcha" \[ref=e\d+\]\n {2}- checkbox "I'm not a robot" \[ref=e\d+\]/);
  assert.doesNotMatch(text, /InlineTextBox|- text: Continue/);
  // same elements keep their refs in the next snapshot
  const again = formatSnapshot(buildSnapshot({ frames, refs, extras, pageUrl: 'https://example.com/login' })).text;
  assert.equal(again, text);
  const robot = /checkbox "I'm not a robot" \[ref=(e\d+)\]/.exec(text)[1];
  assert.deepEqual(refs.get(robot), { session: 'S1', backendId: 2 });
  // a new document: old refs fail, numbering continues
  refs.reset();
  assert.equal(refs.get(robot), null);
  assert.ok(Number(refs.ref('', 5).slice(1)) > 9);
});

test('agent snapshot: interactive filter, subtree, paging and find', () => {
  const refs = new RefMap();
  const snap = buildSnapshot({ frames: [{ key: '|m', session: '', nodes: flatten(page()) }], refs, extras: new Map([['|10', { clickable: true }]]) });
  const inter = formatSnapshot(snap, { filter: 'interactive' }).text.split('\n');
  assert.ok(inter.every((l) => l.startsWith('- ')));
  assert.ok(inter.some((l) => l.startsWith('- heading')));
  assert.ok(!inter.some((l) => l.includes('paragraph')));
  const page1 = formatSnapshot(snap, { maxChars: 80 });
  assert.ok(page1.more && page1.to >= 1);
  const page2 = formatSnapshot(snap, { maxChars: 80, offset: page1.to });
  assert.equal(page2.from, page1.to);
  const sub = formatSnapshot(snap, { ref: 'e1' });
  assert.equal(sub.text.split('\n').length, 1);
  assert.equal(formatSnapshot(snap, { ref: 'e999' }).missing, true);
  const hits = findInSnapshot(snap, 'email field');
  assert.equal(hits.length, 1);
  assert.match(hits[0].text, /textbox "Email"/);
  assert.equal(findInSnapshot(snap, 'continue button').length, 1);
  assert.equal(findInSnapshot(snap, 'nothing like this').length, 0);
});

test('agent snapshot: password values are masked from the DOM type even when Chromium exposes them', () => {
  const refs = new RefMap();
  const root = ax('RootWebArea', 't', { backend: 1, children: [ax('textbox', 'Password', { backend: 2, value: 'hunter2' })] });
  const snap = buildSnapshot({ frames: [{ key: '|m', session: '', nodes: flatten(root) }], refs, extras: new Map([['|2', { password: true }]]) });
  const text = formatSnapshot(snap).text;
  assert.doesNotMatch(text, /hunter2/);
  assert.match(text, /value="••••••"/);
});

// -------------------------------------------------------------------------------------- keys
test('agent keys: chords, aliases and US-layout characters', () => {
  assert.deepEqual(parseChord('Control+Shift+K'), { key: 'K', modifiers: ['Control', 'Shift'] });
  assert.deepEqual(parseChord('ctrl+a'), { key: 'a', modifiers: ['Control'] });
  assert.deepEqual(parseChord('Control++'), { key: '+', modifiers: ['Control'] });
  assert.deepEqual(parseChord('+'), { key: '+', modifiers: [] });
  assert.deepEqual(parseChord('esc'), { key: 'Escape', modifiers: [] });
  assert.deepEqual(parseChord('ControlOrMeta+K', { platform: 'darwin' }), { key: 'K', modifiers: ['Meta'] });
  assert.throws(() => parseChord('Hyper+X'), KeyError);
  assert.throws(() => parseChord('A+B'), /not a modifier/);
  const enter = keyEvents('Enter');
  assert.equal(enter.down.type, 'keyDown');
  assert.equal(enter.down.text, '\r');
  assert.equal(enter.down.windowsVirtualKeyCode, 13);
  const at = keyEvents('@');
  assert.equal(at.down.code, 'Digit2');
  assert.equal(at.down.modifiers, 8); // shift
  const selectAll = keyEvents('a', ['Control'], { platform: 'win32' });
  assert.equal(selectAll.down.type, 'rawKeyDown');
  assert.equal(selectAll.down.text, undefined);
  assert.equal(selectAll.down.modifiers, 2);
  assert.deepEqual(keyEvents('a', ['Meta'], { platform: 'darwin' }).down.commands, ['selectAll']);
  assert.equal(keyEvents('a', ['Meta'], { platform: 'win32' }).down.commands, undefined);
  const downs = modifierEvents(['Control', 'Shift'], true);
  assert.deepEqual(downs.map((e) => e.modifiers), [2, 10]);
  const ups = modifierEvents(['Control', 'Shift'], false);
  assert.deepEqual(ups.map((e) => [e.key, e.modifiers]), [['Shift', 2], ['Control', 0]]);
  assert.equal(modifierMask(['Alt', 'Meta']), 5);
  assert.equal(keyEvents('é').down.text, 'é');
});

// --------------------------------------------------------------------------------------- MCP
function mcpCtx(over = {}) {
  const calls = [];
  return {
    calls,
    ctx: {
      catalog: () => catalog('9.9.9'),
      hasTool: (n) => !!canonicalToolName(n),
      onInitialize: (p) => calls.push(['init', p.clientInfo && p.clientInfo.name]),
      callTool: async (name, args) => {
        calls.push(['call', name, args]);
        return { content: [{ type: 'text', text: `ran ${name}` }] };
      },
      cancel: (id) => calls.push(['cancel', id]),
      ...over,
    },
  };
}

test('agent MCP: initialize, tools, calls, notifications and errors', async () => {
  const { ctx, calls } = mcpCtx();
  const init = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code', version: '2' }, capabilities: {} } }, ctx);
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'ludworks-browser');
  assert.ok(init.result.capabilities.tools);
  assert.match(init.result.instructions, /browser_snapshot/);
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx), null);
  const list = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, ctx);
  assert.equal(list.result.tools.length, TOOL_NAMES.length);
  const r = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_tabs', arguments: { action: 'list' } } }, ctx);
  assert.deepEqual(r.result, { content: [{ type: 'text', text: 'ran browser_tabs' }], isError: false });
  const bad = await handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'rm_rf' } }, ctx);
  assert.equal(bad.error.code, -32602);
  assert.equal((await handleMessage({ jsonrpc: '2.0', id: 5, method: 'nope' }, ctx)).error.code, -32601);
  assert.deepEqual((await handleMessage({ jsonrpc: '2.0', id: 6, method: 'ping' }, ctx)).result, {});
  await handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } }, ctx);
  const batch = await handleMessage([{ jsonrpc: '2.0', id: 7, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }], ctx);
  assert.equal(batch.length, 1);
  assert.equal((await handleMessage({ id: 8, method: 'ping' }, ctx)).error.code, -32600);
  assert.deepEqual(calls.map((c) => c[0]), ['init', 'call', 'cancel']);
  assert.equal(negotiateVersion('2024-11-05'), '2024-11-05');
  assert.equal(negotiateVersion('2099-01-01'), '2099-01-01');
  assert.equal(negotiateVersion('garbage'), '2025-11-25');
  assert.equal(expectsResponse({ jsonrpc: '2.0', method: 'notifications/x' }), false);
  assert.equal(initializeClientName([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'cursor' } } }]), 'cursor');
  const boom = mcpCtx({ callTool: async () => { throw new Error('kaput'); } });
  assert.equal((await handleMessage({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'browser_tabs' } }, boom.ctx)).error.message, 'kaput');
});

// ------------------------------------------------------------------------------------ server
function request(port, { method = 'GET', path: p = '/v1/status', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

test('agent server: token, Host and Origin checks; routes; discovery file', async () => {
  const seen = [];
  const handler = {
    status: () => ({ ok: true }),
    catalog: () => catalog('1'),
    call: async (id, tool, args) => {
      seen.push([id, tool, args]);
      if (tool === 'denied') throw new HttpError(403, 'no', 'denied');
      return { content: [{ type: 'text', text: 'ok' }], isError: false };
    },
    mcp: async (id, msg) => ({ response: msg.id === undefined ? null : { jsonrpc: '2.0', id: msg.id, result: {} }, sessionId: 'S-1' }),
    endSession: (id) => seen.push(['end', id.session]),
  };
  const token = 'a'.repeat(64);
  const server = new AgentServer({ token, handler });
  const port = await server.listen(0);
  const auth = { Authorization: `Bearer ${token}`, Host: `127.0.0.1:${port}` };
  try {
    assert.equal((await request(port, { headers: { Host: `127.0.0.1:${port}` } })).status, 401);
    assert.equal((await request(port, { headers: { ...auth, Authorization: `Bearer ${'b'.repeat(64)}` } })).status, 401);
    assert.equal((await request(port, { headers: { ...auth, Host: `evil.example:${port}` } })).status, 403);
    assert.equal((await request(port, { headers: { ...auth, Origin: 'https://evil.example' } })).status, 403);
    assert.deepEqual((await request(port, { headers: auth })).body, { ok: true });
    assert.equal((await request(port, { headers: { ...auth, Host: `localhost:${port}` } })).status, 200);
    assert.equal((await request(port, { path: '/v1/tools', headers: auth })).body.tools.length, TOOL_NAMES.length);
    const r = await request(port, { method: 'POST', path: '/v1/call', headers: { ...auth, 'X-Lwb-Client': 'Vision', 'X-Lwb-Session': 'abc', 'X-Lwb-Label': 'proj' }, body: { tool: 'browser_tabs', args: { action: 'list' } } });
    assert.equal(r.status, 200);
    assert.deepEqual(seen[0][0], { client: 'Vision', session: 'abc', label: 'proj', mcpSession: '' });
    assert.equal((await request(port, { method: 'POST', path: '/v1/call', headers: auth, body: { tool: 'denied' } })).status, 403);
    assert.equal((await request(port, { method: 'POST', path: '/v1/call', headers: auth, body: '{nope' })).status, 400);
    const m = await request(port, { method: 'POST', path: '/mcp', headers: auth, body: { jsonrpc: '2.0', id: 1, method: 'ping' } });
    assert.equal(m.status, 200);
    assert.equal(m.headers['mcp-session-id'], 'S-1');
    assert.equal((await request(port, { method: 'POST', path: '/mcp', headers: auth, body: { jsonrpc: '2.0', method: 'notifications/initialized' } })).status, 202);
    assert.equal((await request(port, { method: 'POST', path: '/mcp', headers: auth, body: '{bad' })).body.error.code, -32700);
    assert.equal((await request(port, { method: 'GET', path: '/mcp', headers: auth })).status, 405);
    assert.equal((await request(port, { method: 'DELETE', path: '/mcp', headers: { ...auth, 'X-Lwb-Session': 'zz' } })).status, 204);
    assert.deepEqual(seen.at(-1), ['end', 'zz']);
    assert.equal((await request(port, { path: '/nope', headers: auth })).status, 404);
  } finally {
    await server.close();
  }
  // a second server on the same preferred port falls back to a free one
  const a = new AgentServer({ token, handler });
  const pa = await a.listen(0);
  const b = new AgentServer({ token, handler });
  const pb = await b.listen(pa);
  assert.notEqual(pa, pb);
  await a.close();
  await b.close();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lwb-'));
  writeEndpoint(dir, { port: 1234, token, pid: 1 });
  const ep = JSON.parse(readFileSync(path.join(dir, ENDPOINT_FILE), 'utf8'));
  assert.equal(ep.version, 1);
  assert.equal(ep.port, 1234);
  removeEndpoint(dir, 999); // not ours: stays
  assert.ok(existsSync(path.join(dir, ENDPOINT_FILE)));
  removeEndpoint(dir, 1234);
  assert.ok(!existsSync(path.join(dir, ENDPOINT_FILE)));
  assert.equal(cleanHeader('a\u202eb\nc'), 'abc');
});

// ------------------------------------------------------------------------------ integrations
test('agent integrations: Vision command templates per shell', () => {
  const tool = toolList().find((t) => t.name === 'browser_type');
  const ps = visionCommand(tool, { exe: "C:\\Users\\O'Neil\\AppData\\Local\\Programs\\Ludworks Browser\\lwb.exe", shell: 'powershell', platform: 'win32' });
  assert.match(ps, /^@\{\nref=@'\n\$\{ref\}\n'@\ntext=@'\n\$\{text\}\n'@\n/);
  assert.match(ps, /\} \| ConvertTo-Json -Compress \| & 'C:\\Users\\O''Neil\\AppData\\Local\\Programs\\Ludworks Browser\\lwb\.exe' --client=Vision --max-output=15000 --ps-quoted browser_type --stdin$/);
  // every ${…} in the template is a parameter Vision fills in
  for (const m of ps.matchAll(/\$\{(\w+)\}/g)) assert.ok(tool.inputSchema.properties[m[1]], m[1]);
  const noArgs = visionCommand(toolList().find((t) => t.name === 'browser_downloads'), { exe: 'C:\\x\\lwb.exe', shell: 'powershell', platform: 'win32' });
  assert.equal(noArgs, "& 'C:\\x\\lwb.exe' --client=Vision --max-output=15000 --ps-quoted browser_downloads");
  const bash = visionCommand(tool, { exe: 'C:\\Program Files\\L B\\lwb.exe', shell: 'bash', platform: 'win32' });
  assert.equal(bash, "MSYS_NO_PATHCONV=1 'C:/Program Files/L B/lwb.exe' --client=Vision --max-output=15000 browser_type --ref=${ref} --text=${text} --clear=${clear} --submit=${submit} --slowly=${slowly} --tab=${tab} --snapshot=${snapshot}");
  const mac = visionCommand(tool, { exe: '/Applications/Ludworks Browser.app/Contents/MacOS/lwb', shell: 'bash', platform: 'darwin' });
  assert.match(mac, /^MSYS_NO_PATHCONV=1 '\/Applications\/Ludworks Browser\.app\/Contents\/MacOS\/lwb' /);
  const cmd = visionCommand(tool, { exe: 'C:\\L B\\lwb.exe', shell: 'cmd', platform: 'win32' });
  assert.match(cmd, /^"C:\\L B\\lwb\.exe" --client=Vision --max-output=15000 browser_type --ref=\$\{ref\}/);
  const m = visionManifest({ exe: 'C:\\x\\lwb.exe', shell: 'powershell', platform: 'win32', version: '0.2.0' });
  assert.equal(m.name, 'ludworks-browser');
  assert.equal(m.tools.length, TOOL_NAMES.length);
  assert.ok(m.tools.every((t) => t.requiresApproval === false && t.timeout >= 60 && t.timeout <= 600 && t.parameters.type === 'object'));
  assert.match(m.tools.find((t) => t.name === 'browser_screenshot').description, /view_image/);
  assert.equal(visionShell({ agentShell: 'auto' }, 'win32'), 'powershell');
  assert.equal(visionShell({ agentShell: 'cmd' }, 'win32'), 'cmd');
  assert.equal(visionShell({ agentShell: 'bash' }, 'win32'), 'bash');
  assert.equal(visionShell({ agentShell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' }, 'win32'), 'powershell');
  assert.equal(visionShell(null, 'darwin'), 'bash');
  assert.equal(visionPaths({ platform: 'win32', env: { APPDATA: 'C:\\U\\AppData\\Roaming' } }).plugins, 'C:\\U\\AppData\\Roaming\\Vision\\plugins');
  assert.equal(visionPaths({ platform: 'darwin', env: {}, home: '/Users/u' }).plugins, '/Users/u/Library/Application Support/Vision/plugins');
  assert.equal(visionPaths({ platform: 'win32', env: { VISION_HOME: 'D:\\V' } }).root, 'D:\\V');
});

test('agent integrations: skill, MCP configs and the Claude Code allow rule', () => {
  const md = skillMarkdown();
  assert.match(md, /^---\nname: ludworks-browser\ndescription: .+\n---\n/);
  assert.match(md, /mcp__ludworks-browser__browser_\*/);
  assert.deepEqual(mcpStdioConfig('C:\\x\\lwb.exe'), { mcpServers: { 'ludworks-browser': { command: 'C:\\x\\lwb.exe', args: ['mcp'] } } });
  assert.deepEqual(claudeAddArgs('/x/lwb'), ['mcp', 'add', '--scope', 'user', 'ludworks-browser', '--', '/x/lwb', 'mcp']);
  const next = JSON.parse(allowInClaudeSettings('{"model":"opus","permissions":{"allow":["Bash(ls)"]}}'));
  assert.deepEqual(next, { model: 'opus', permissions: { allow: ['Bash(ls)', 'mcp__ludworks-browser'] } });
  assert.equal(allowInClaudeSettings(JSON.stringify(next)), null); // already there
  assert.deepEqual(JSON.parse(allowInClaudeSettings('')), { permissions: { allow: ['mcp__ludworks-browser'] } });
  assert.equal(allowInClaudeSettings('// comments\n{}'), null);
});

test('agent integrations: the Claude desktop app config is found and the server merged in', () => {
  const env = { LOCALAPPDATA: 'C:\\U\\AppData\\Local', APPDATA: 'C:\\U\\AppData\\Roaming' };
  const dirs = {
    'C:\\U\\AppData\\Local\\Claude-Data': ['claude_pzs8sxrjxfjjc', 'README.txt'],
    'C:\\U\\AppData\\Roaming\\Claude': ['.user-data-left.claude_pzs8sxrjxfjjc'],
  };
  const packaged = 'C:\\U\\AppData\\Local\\Claude-Data\\claude_pzs8sxrjxfjjc\\claude_desktop_config.json';
  // a packaged install: its data folder, never the old Roaming folder it left
  assert.deepEqual(claudeDesktopConfigPaths({ platform: 'win32', env, list: (d) => dirs[d] || [], exists: (p) => p === packaged }), [packaged]);
  // a classic install: %APPDATA%\Claude
  assert.deepEqual(claudeDesktopConfigPaths({ platform: 'win32', env, list: () => [] }), ['C:\\U\\AppData\\Roaming\\Claude\\claude_desktop_config.json']);
  assert.deepEqual(claudeDesktopConfigPaths({ platform: 'darwin', env: {}, home: '/Users/u' }), ['/Users/u/Library/Application Support/Claude/claude_desktop_config.json']);
  const merged = addMcpServer('{"coworkUserFilesPath":"x","preferences":{"a":1},"mcpServers":{"other":{"command":"o"}}}', 'C:\\L\\lwb.exe');
  assert.deepEqual(JSON.parse(merged), { coworkUserFilesPath: 'x', preferences: { a: 1 }, mcpServers: { other: { command: 'o' }, 'ludworks-browser': { command: 'C:\\L\\lwb.exe', args: ['mcp'] } } });
  assert.equal(addMcpServer(merged, 'C:\\L\\lwb.exe'), null); // already there
  assert.match(addMcpServer(merged, 'D:\\New\\lwb.exe'), /D:\\\\New\\\\lwb\.exe/); // moved install: updated
  assert.deepEqual(JSON.parse(addMcpServer('', '/x/lwb')), { mcpServers: { 'ludworks-browser': { command: '/x/lwb', args: ['mcp'] } } });
  assert.equal(addMcpServer('{broken', '/x/lwb'), null);
  assert.equal(addMcpServer('[1]', '/x/lwb'), null);
});

// ---------------------------------------------------------------------------------- annotate
test('agent annotate: boxes and labels are drawn into the bitmap', () => {
  const w = 60;
  const hgt = 40;
  const buf = Buffer.alloc(w * hgt * 4, 0);
  const n = drawMarks(buf, w, hgt, [{ x: 10, y: 20, w: 30, h: 15, label: 'e7' }, { x: 500, y: 500, w: 5, h: 5, label: 'e8' }], { scale: 1 });
  assert.equal(n, 1); // the second is outside the image
  const px = (x, y) => [...buf.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)];
  assert.deepEqual(px(10, 25), [108, 51, 214, 255]); // the box edge, BGRA of the first colour
  assert.deepEqual(px(0, 0), [0, 0, 0, 0]);
  assert.equal(labelSize('e12', 2).width, 3 * 12 + 4);
});

// ------------------------------------------------------------------------------- UI smoke tests
// A tiny DOM, enough for the overlay popups and the settings section to render and be clicked.
function fakeDom() {
  const doc = {};
  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.nodeType = 1;
      this.attributes = {};
      this.childNodes = [];
      this.listeners = {};
      this.dataset = {};
      this.style = {};
      this.className = '';
      this.parentNode = null;
    }
    setAttribute(k, v) {
      this.attributes[k] = String(v);
    }
    getAttribute(k) {
      return this.attributes[k] ?? null;
    }
    appendChild(c) {
      if (c.parentNode) c.parentNode.removeChild(c);
      c.parentNode = this;
      this.childNodes.push(c);
      return c;
    }
    append(...cs) {
      for (const c of cs) this.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c);
    }
    removeChild(c) {
      this.childNodes.splice(this.childNodes.indexOf(c), 1);
      c.parentNode = null;
      return c;
    }
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    }
    get firstChild() {
      return this.childNodes[0] || null;
    }
    addEventListener(t, fn) {
      (this.listeners[t] ||= []).push(fn);
    }
    fire(t) {
      for (const fn of this.listeners[t] || []) fn({ type: t, currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} });
    }
    focus() {}
    get textContent() {
      return this.childNodes.map((c) => c.textContent).join('');
    }
    set textContent(v) {
      this.childNodes = [doc.createTextNode(String(v))];
    }
  }
  Object.assign(doc, {
    createElement: (t) => new El(t),
    createElementNS: (_ns, t) => new El(t),
    createTextNode: (v) => ({ nodeType: 3, textContent: String(v), parentNode: null }),
    querySelector: () => null,
    head: new El('head'),
    documentElement: new El('html'),
  });
  const all = (el, out = []) => {
    if (el && el.nodeType === 1) {
      out.push(el);
      for (const c of el.childNodes) all(c, out);
    }
    return out;
  };
  const button = (root, label) => all(root).find((e) => e.tagName === 'BUTTON' && e.textContent.trim() === label);
  return { doc, all, button };
}

const tick = () => new Promise((r) => setImmediate(r));

test('agent UI: the toolbar popup and the approval prompts render and answer', async () => {
  const { doc, all, button } = fakeDom();
  globalThis.document = doc;
  const { POPUPS } = await import('../build/app/shell/overlay-agents.js');
  const acts = [];
  const data = {
    on: true,
    sessions: [
      { key: 'Claude Code|1', client: 'Claude Code', label: 'proj', busy: true, stopped: false, tabs: 2, calls: 5, lastTool: 'browser_click', lastUsed: Date.now() },
      { key: 'Vision|2', client: 'Vision', label: '', busy: false, stopped: true, tabs: 0, calls: 1, lastTool: '', lastUsed: Date.now() - 90000 },
    ],
  };
  const menu = POPUPS.agents(data, {}, { act: async (a, d) => (acts.push([a, d]), { on: true, sessions: [] }) });
  assert.match(menu.textContent, /AI agents.*2 connected.*Claude Code · proj.*Working · click.*Vision.*Stopped by you/s);
  button(menu, 'Stop').fire('click');
  button(menu, 'Resume').fire('click');
  await tick();
  assert.deepEqual(acts.slice(0, 2), [['stop', { key: 'Claude Code|1' }], ['resume', { key: 'Vision|2' }]]);
  assert.match(menu.textContent, /None connected/); // re-rendered from the action's answer
  const answers = [];
  const call = (cmd, a) => answers.push([cmd, a]);
  const connect = POPUPS['agent-approve']({ promptId: 'p1', kind: 'connect', client: 'Claude Code', turnOn: true }, {}, { call });
  assert.match(connect.textContent, /Let Claude Code use Ludworks Browser\?.*turns on AI agent access/s);
  button(connect, 'Always allow Claude Code').fire('click');
  assert.deepEqual(answers.pop(), ['prompt.answer', { id: 'p1', value: { decision: 'always' } }]);
  const accounts = [{ id: 'a1', name: 'GitHub', username: 'ada' }, { id: 'a2', name: 'GitHub work', username: 'ada-work' }];
  const login = POPUPS['agent-approve']({ promptId: 'p2', kind: 'login', client: 'Vision', host: 'github.com', accounts }, {}, { call });
  assert.match(login.textContent, /Sign in to github\.com for Vision\?.*never sees it.*ada.*ada-work/s);
  const radios = all(login).filter((e) => e.tagName === 'INPUT');
  radios[1].checked = true;
  radios[1].fire('change');
  button(login, 'Allow once').fire('click');
  assert.deepEqual(answers.pop(), ['prompt.answer', { id: 'p2', value: { decision: 'once', account: 'a2' } }]);
  const share = POPUPS['agent-approve']({ promptId: 'p3', kind: 'share', client: 'Vision', title: 'Inbox', host: 'mail.example' }, {}, { call });
  button(share, 'Don’t share').fire('click');
  assert.deepEqual(answers.pop(), ['prompt.answer', { id: 'p3', value: { decision: 'deny' } }]);
});

test('agent UI: the settings section renders its state and runs the setup commands', async () => {
  const { doc, all, button } = fakeDom();
  globalThis.document = doc;
  const listeners = [];
  globalThis.window = { lwPage: { on: (_ev, fn) => listeners.push(fn) }, confirm: () => true };
  const { agentsSection } = await import('../build/app/pages/settings-agents.js');
  const calls = [];
  const state = {
    on: true,
    running: true,
    port: 47821,
    endpoint: 'C:\\p\\agent-endpoint.json',
    scope: 'own',
    scripts: true,
    logins: 'ask',
    clients: [{ name: 'Claude Code', added: 1 }],
    sessions: [{ client: 'Vision', label: 'site', tabs: 1, calls: 3, stopped: false }],
    cli: { path: 'C:\\L\\lwb.exe', exists: true },
    claude: { path: 'C:\\c\\claude.exe', configured: false },
    vision: { found: true, installed: false, shell: 'powershell', plugins: 'C:\\V\\plugins' },
    mcpJson: '{"mcpServers":{}}',
  };
  const call = async (cmd, a) => {
    calls.push([cmd, a]);
    if (cmd === 'agent.state') return state;
    if (cmd === 'agent.setup-claude') return { ok: true, done: ['Added it'], note: 'Start a new session.' };
    if (cmd === 'agent.setup-vision') return { ok: false, error: 'No Vision', done: [] };
    return { ok: true };
  };
  const root = doc.createElement('main');
  root.append(...agentsSection(call));
  await tick();
  assert.match(root.textContent, /AI agents.*Listening on 127\.0\.0\.1:47821.*Connect agents.*Claude Code.*Vision.*Allowed agents.*Connected now: Vision · site/s);
  button(root, 'Connect Claude Code').fire('click');
  await tick();
  assert.deepEqual(calls.find((c) => c[0] === 'agent.setup-claude'), ['agent.setup-claude', { allow: true }]);
  assert.match(root.textContent, /✓ Added it.*Start a new session/s);
  button(root, 'Add to Vision').fire('click');
  await tick();
  assert.match(root.textContent, /No Vision/);
  button(root, 'Forget').fire('click');
  await tick();
  assert.deepEqual(calls.find((c) => c[0] === 'agent.forget-client'), ['agent.forget-client', { name: 'Claude Code' }]);
  assert.ok(all(root).filter((e) => e.tagName === 'INPUT' && e.attributes.type === 'checkbox').length >= 2);
  assert.equal(listeners.length, 1);
});
