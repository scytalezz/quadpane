'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const path = require('node:path');
const { createDirectoryService, readerPath } = require('./directory-service.cjs');

const entry = { name: '한글.txt', type: 'file', size: 3, modified: '2026-01-02T03:04:05.000Z', hidden: false };
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(options = {}) {
  const children = [], timers = new Map();
  let nextTimer = 0;
  const service = createDirectoryService({
    ...options,
    setTimer(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    spawnProcess(executable, args, opts) {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), requests: [], killed: false,
        unref() { this.unreferenced = true; },
        kill() { this.killed = true; this.emit('exit', 1); },
        respond(value) { this.stdout.write(JSON.stringify(value) + '\n'); },
      });
      child.stdin.setEncoding('utf8').on('data', data => child.requests.push(JSON.parse(data)));
      children.push({ child, executable, args, opts });
      return child;
    },
  });
  return { service, children, timers, fire(delay) {
    const match = [...timers].find(([, value]) => value.delay === delay);
    assert.ok(match, `timer ${delay} exists`);
    timers.delete(match[0]); match[1].fn();
  } };
}

test('directory worker resolves development and packaged paths', () => {
  const root = 'C:\\project\\desktop', resourcesPath = 'D:\\packaged resources';
  for (const runtime of [{}, { defaultApp: false }, { resourcesPath, defaultApp: true }]) {
    assert.equal(readerPath(runtime, root), path.join(root, 'native', 'bin', 'Quadpane.Directory.exe'));
  }
  for (const runtime of [{ resourcesPath }, { resourcesPath, defaultApp: false }]) {
    assert.equal(readerPath(runtime, root), path.join(resourcesPath, 'native', 'Quadpane.Directory.exe'));
  }
});

test('multiple directories reuse one worker with fixed arguments and UTF-8 JSON paths', async t => {
  const h = harness(); t.after(() => h.service.close());
  const folders = ["C:\\한글 & ' ` $ (1)", '\\\\server\\공유\\폴더'];
  const first = h.service.list(folders[0]), second = h.service.list(folders[1]);
  const { child, args, opts } = h.children[0];
  assert.equal(h.children.length, 1);
  assert.deepEqual(args, []);
  assert.equal(opts.windowsHide, true);
  assert.equal(opts.shell, undefined);
  assert.deepEqual(opts.stdio, ['pipe', 'pipe', 'ignore']);
  assert.ok(child.unreferenced);
  assert.deepEqual(child.requests, [{ id: 1, path: path.win32.toNamespacedPath(folders[0]), accurate: false }]);
  const bytes = Buffer.from(JSON.stringify({ id: 1, ok: true, entries: [entry] }) + '\n');
  for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
  assert.deepEqual(await first, [entry], 'UTF-8 survives arbitrary pipe chunk boundaries');
  assert.deepEqual(child.requests[1], { id: 2, path: path.win32.toNamespacedPath(folders[1]), accurate: false });
  child.respond({ id: 2, ok: true, entries: [] });
  assert.deepEqual(await second, []);
  assert.equal(h.children.length, 1);
  assert.ok([...h.timers.values()].some(timer => timer.delay === 10000));
});

test('explicit accurate refresh is forwarded and unavailable metadata stays marked', async t => {
  const h = harness(); t.after(() => h.service.close());
  const pending = h.service.list('C:\\folder', { accurate: true });
  const child = h.children[0].child;
  assert.equal(child.requests[0].accurate, true);
  const unavailable = { ...entry, isSymbolicLink: true, unavailable: true };
  child.respond({ id: 1, ok: true, entries: [unavailable] });
  assert.deepEqual(await pending, [unavailable]);
});

test('idle worker is released; the next navigation creates a fresh worker', async t => {
  const h = harness(); t.after(() => h.service.close());
  const first = h.service.list('C:\\folder');
  h.children[0].child.respond({ id: 1, ok: true, entries: [] });
  await first;
  h.fire(10000);
  assert.ok(h.children[0].child.killed);
  const next = h.service.list('C:\\folder');
  assert.equal(h.children.length, 2);
  h.children[1].child.respond({ id: 2, ok: true, entries: [entry] });
  assert.deepEqual(await next, [entry]);
});

test('native file errors keep the worker usable and expose sanitized error codes', async t => {
  const h = harness(); t.after(() => h.service.close());
  for (const [win32Code, code] of [[2, 'ENOENT'], [5, 'EACCES'], [21, 'ENODEV'], [53, 'ENETUNREACH'], [267, 'ENOTDIR'], [99999, 'DIRECTORY_READ_FAILED']]) {
    const pending = h.service.list('C:\\private');
    const expected = assert.rejects(pending, error => error.code === code && !error.message.includes('private'));
    const child = h.children[0].child;
    child.respond({ id: child.requests.at(-1).id, ok: false, error: { win32Code } });
    await expected;
  }
  assert.equal(h.children.length, 1);
});

test('worker timeout terminates active/queued requests and allows recovery', async t => {
  const h = harness(); t.after(() => h.service.close());
  const first = assert.rejects(h.service.list('C:\\slow'), { code: 'ETIMEDOUT' });
  const second = assert.rejects(h.service.list('C:\\queued'), { code: 'ETIMEDOUT' });
  h.fire(15000);
  await Promise.all([first, second]);
  assert.ok(h.children[0].child.killed);
  const recovered = h.service.list('C:\\other');
  h.children[1].child.respond({ id: 3, ok: true, entries: [] });
  await recovered;
});

test('unexpected exit, broken input, corrupt responses and excessive output fail closed', async () => {
  const cases = [
    child => child.emit('exit', 1),
    child => child.stdin.emit('error', new Error('EPIPE')),
    child => child.stdout.end(),
    child => child.stdout.write('not json\n'),
    child => child.respond({ id: 99, ok: true, entries: [] }),
    child => child.respond({ id: 1, ok: true, entries: [{ ...entry, hidden: undefined }] }),
    child => child.respond({ id: 1, ok: true, entries: [{ ...entry, name: '..\\outside' }] }),
    child => child.respond({ id: 1, ok: true, entries: [{ ...entry, modified: 'bad date' }] }),
    child => child.stdout.write('x'.repeat(1025)),
  ];
  for (const trigger of cases) {
    const h = harness({ maxResponseBytes: 1024 });
    try {
      const pending = assert.rejects(h.service.list('C:\\fixture'), { code: 'DIRECTORY_READ_FAILED' });
      trigger(h.children[0].child);
      await pending;
      assert.ok(h.children[0].child.killed);
    } finally { h.service.close(); }
  }
});

test('shutdown rejects queued work, closes pipes and never spawns again', async () => {
  const h = harness();
  const pending = [h.service.list('C:\\a'), h.service.list('C:\\b')].map(promise => assert.rejects(promise, { code: 'DIRECTORY_READ_FAILED' }));
  h.service.close();
  await Promise.all(pending);
  await assert.rejects(h.service.list('C:\\c'), { code: 'DIRECTORY_READ_FAILED' });
  assert.equal(h.children.length, 1);
  assert.ok(h.children[0].child.stdin.destroyed);
  assert.equal(h.timers.size, 0);
  await tick();
});

test('synchronous spawn errors are returned without leaving a live timeout', async () => {
  const service = createDirectoryService({ spawnProcess() { throw new Error('missing helper'); } });
  await assert.rejects(service.list('C:\\fixture'), { code: 'DIRECTORY_READ_FAILED' });
  service.close();
});
