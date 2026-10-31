// "Move to separate process": the second engine instance's profile and command line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { SEPARATE_DIR, separateProfileDir, isSeparateProfile, canMove, otherEngineCommand, launch } from '../build/app/main/separate.js';

const main = path.resolve('/profiles/User Data');
const sep = path.join(main, SEPARATE_DIR);

test('separate: profile next to the main one, recognised by its folder', () => {
  assert.equal(separateProfileDir(main), sep);
  assert.ok(isSeparateProfile(sep));
  assert.ok(isSeparateProfile(`${sep}${path.sep}`));
  assert.ok(!isSeparateProfile(main));
});

test('separate: only web pages and files move', () => {
  for (const u of ['https://www.twitch.tv/x', 'http://192.0.2.10:43594/', 'file:///C:/game/index.html']) assert.ok(canMove(u), u);
  for (const u of ['ludworks://settings/', 'ludworks://newtab/', 'about:blank', 'chrome-extension://abc/popup.html', '', null]) assert.ok(!canMove(u), String(u));
});

test('separate: main → separate names the separate profile; the URL can never be a switch', () => {
  const c = otherEngineCommand({ execPath: '/opt/lwb', profileDir: main, defaultProfileDir: main, url: 'https://www.twitch.tv/x' });
  assert.deepEqual(c, { file: '/opt/lwb', args: [`--profile=${sep}`, '--single-argument', 'https://www.twitch.tv/x'] });
});

test('separate: back to a default main profile starts it normally (no --profile)', () => {
  const c = otherEngineCommand({ execPath: '/opt/lwb', profileDir: sep, defaultProfileDir: main, url: 'https://x.test/' });
  assert.deepEqual(c.args, ['--single-argument', 'https://x.test/']);
});

test('separate: back to a named main profile names it; unpackaged runs keep the app directory first', () => {
  const other = path.resolve('/tmp/test-profile');
  const c = otherEngineCommand({ execPath: '/opt/electron', appPath: '/src/app', profileDir: separateProfileDir(other), defaultProfileDir: main, url: 'https://x.test/' });
  assert.deepEqual(c.args, ['/src/app', `--profile=${other}`, '--single-argument', 'https://x.test/']);
});

test('separate: launch resolves once the process runs, rejects when it cannot start', async () => {
  const calls = [];
  const fake = (outcome) => (file, args, opts) => {
    calls.push({ file, args, opts });
    const child = Object.assign(new EventEmitter(), { unref: () => (child.unrefd = true) });
    setImmediate(() => (outcome === 'spawn' ? child.emit('spawn') : child.emit('error', new Error('ENOENT'))));
    return child;
  };
  await launch({ file: '/opt/lwb', args: ['a'] }, fake('spawn'));
  assert.deepEqual(calls[0], { file: '/opt/lwb', args: ['a'], opts: { detached: true, stdio: 'ignore' } });
  await assert.rejects(launch({ file: '/nope', args: [] }, fake('error')), /ENOENT/);
});
