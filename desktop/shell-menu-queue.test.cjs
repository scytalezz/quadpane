'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createShellMenuService } = require('./shell-menu.cjs');

function fixture(t) {
  const workers = [], sent = [];
  const service = createShellMenuService('fake.exe', { spawn() {
    const worker = new EventEmitter();
    worker.stdin = new PassThrough(); worker.stdout = new PassThrough(); worker.stderr = new PassThrough();
    worker.stdin.on('data', data => sent.push({ worker, ...JSON.parse(data) }));
    worker.kill = () => { worker.killed = true; };
    workers.push(worker);
    return worker;
  } });
  t.after(() => service.cancel());
  const show = mode => service.show({ parent: __dirname, paths: [], operation: 'copy' }, {}, mode);
  const reply = (index, value = {}, extra = {}) => {
    const { worker, id } = sent[index];
    worker.stdout.write(JSON.stringify({ id, ok: true, value, ...extra }) + '\n');
  };
  async function waitFor(count) {
    for (let i = 0; sent.length < count && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(sent.length, count, 'helper request count');
  }
  return { service, workers, sent, show, reply, waitFor };
}

for (const mode of ['show', 'drag']) test(`pending focus clipboard read precedes ${mode}`, async t => {
  const f = fixture(t);
  const read = f.show('readClipboard');
  const ui = f.show(mode);
  // Attach handlers immediately so failures are reported as assertions.
  const done = Promise.all([read, ui]);
  await f.waitFor(1);
  assert.equal(f.sent[0].mode, 'readClipboard');
  f.reply(0, { sources: [] });
  await f.waitFor(2);
  assert.equal(f.sent[1].mode, mode);
  f.reply(1, { action: 'cancel' });
  assert.deepEqual(await done, [{ sources: [] }, { action: 'cancel' }]);
  assert.equal(f.service.pending, false);
});

test('clipboard reads, writes and completions remain ordered before a menu', async t => {
  const f = fixture(t);
  const modes = ['readClipboard', 'writeClipboard', 'completePaste', 'readClipboard', 'show'];
  const done = Promise.all(modes.map(f.show));
  for (let i = 0; i < modes.length; i++) {
    await f.waitFor(i + 1);
    assert.equal(f.sent[i].mode, modes[i]);
    f.reply(i, { order: i });
  }
  assert.deepEqual(await done, modes.map((_, order) => ({ order })));
});

for (const active of ['show', 'drag']) test(`${active} rejects nested UI and clipboard promptly with SHELL_BUSY`, async t => {
  const f = fixture(t);
  const ui = f.show(active);
  // Reservation includes asynchronous validation, before the helper is called.
  for (const mode of ['show', 'drag', 'readClipboard', 'writeClipboard', 'completePaste']) {
    await assert.rejects(f.show(mode), { code: 'SHELL_BUSY' });
  }
  await f.waitFor(1);
  f.reply(0);
  await ui;
});

test('a queued UI reservation cannot collect clipboard work behind its nested message loop', async t => {
  const f = fixture(t);
  const read = f.show('readClipboard'), drag = f.show('drag');
  const done = Promise.all([read, drag]);
  await assert.rejects(f.show('readClipboard'), { code: 'SHELL_BUSY' });
  await assert.rejects(f.show('show'), { code: 'SHELL_BUSY' });
  await f.waitFor(1); f.reply(0);
  await f.waitFor(2); f.reply(1);
  await done;
});

test('cancel rejects active and queued requests and stale worker events cannot poison replacement', async t => {
  const f = fixture(t);
  const results = Promise.all(['readClipboard', 'completePaste', 'show'].map(mode =>
    assert.rejects(f.show(mode), { code: 'SHELL_CANCELLED' })));
  await f.waitFor(1);
  const old = f.workers[0];
  f.service.cancel();
  await results;
  assert.equal(f.service.pending, false);
  assert.equal(old.killed, true);
  const next = f.show('readClipboard');
  await f.waitFor(2);
  old.stdin.emit('error', new Error('stale pipe'));
  old.emit('error', new Error('stale spawn'));
  old.emit('exit', 1);
  f.reply(0);
  f.reply(1, { fresh: true });
  assert.deepEqual(await next, { fresh: true });
});

for (const failure of ['exit', 'pipe', 'protocol']) test(`${failure} rejects queue and allows a fresh helper`, async t => {
  const f = fixture(t);
  const code = failure === 'exit' ? 'SHELL_HELPER_EXITED' : failure === 'pipe' ? 'EPIPE' : 'SHELL_PROTOCOL_ERROR';
  const rejected = Promise.all(['readClipboard', 'completePaste', 'drag'].map(mode =>
    assert.rejects(f.show(mode), { code })));
  await f.waitFor(1);
  const old = f.workers[0];
  if (failure === 'exit') old.emit('exit', 7, null);
  else if (failure === 'pipe') old.stdin.emit('error', Object.assign(new Error('broken pipe'), { code }));
  else old.stdout.write('invalid JSON\n');
  await rejected;
  const next = f.show('readClipboard');
  await f.waitFor(2);
  assert.equal(f.workers.length, 2);
  old.emit('exit', 1);
  f.reply(1, 'recovered');
  assert.equal(await next, 'recovered');
});

test('native failure preserves details and still drains clipboard queue', async t => {
  const f = fixture(t);
  const rejected = assert.rejects(f.show('readClipboard'), error => {
    assert.equal(error.code, 'SHELL_NATIVE_ERROR');
    assert.equal(error.nativeError, 'COM failure 0x800401D0');
    return true;
  });
  const next = f.show('completePaste');
  await f.waitFor(1);
  f.reply(0, null, { ok: false, error: 'COM failure 0x800401D0' });
  await rejected;
  await f.waitFor(2); f.reply(1, { changed: false });
  assert.deepEqual(await next, { changed: false });
});

test('validation failure releases the reservation and queued clipboard work', async t => {
  const f = fixture(t);
  const rejected = assert.rejects(f.service.show(null, {}, 'writeClipboard'));
  const next = f.show('readClipboard');
  await rejected;
  await f.waitFor(1); f.reply(0);
  await next;
  assert.equal(f.service.pending, false);
});

test('cancel before validation finishes rejects the whole queue without spawning stale work', async t => {
  const f = fixture(t);
  const cancelled = Promise.all(['writeClipboard', 'readClipboard', 'drag'].map(mode =>
    assert.rejects(f.show(mode), { code: 'SHELL_CANCELLED' })));
  f.service.cancel();
  await cancelled;
  const next = f.show('readClipboard');
  await f.waitFor(1);
  assert.equal(f.sent[0].mode, 'readClipboard');
  f.reply(0);
  await next;
  assert.equal(f.workers.length, 1);
});

test('spawn failure rejects queued requests and does not poison retry', async t => {
  let attempts = 0;
  const service = createShellMenuService('absent.exe', { spawn() {
    attempts++;
    throw Object.assign(new Error('missing helper'), { code: 'ENOENT' });
  } });
  t.after(() => service.cancel());
  await Promise.all(['readClipboard', 'completePaste', 'show'].map(mode =>
    assert.rejects(service.show({ parent: __dirname, paths: [] }, {}, mode), { code: 'ENOENT' })));
  assert.equal(attempts, 1);
  await assert.rejects(service.show({}, {}, 'readClipboard'), { code: 'ENOENT' });
  assert.equal(attempts, 2);
  assert.equal(service.pending, false);
});

test('close rejects queued requests while ending the helper input gracefully', async t => {
  const f = fixture(t);
  const rejected = Promise.all(['readClipboard', 'completePaste', 'show'].map(mode =>
    assert.rejects(f.show(mode), { code: 'SHELL_CANCELLED' })));
  await f.waitFor(1);
  f.service.close();
  await rejected;
  assert.equal(f.workers[0].stdin.writableEnded, true);
  assert.equal(f.workers[0].killed, undefined);
  assert.equal(f.service.pending, false);
  f.workers[0].emit('exit', 0);
});
