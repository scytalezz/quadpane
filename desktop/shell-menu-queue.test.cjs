'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createShellMenuService } = require('./shell-menu.cjs');

function fixture(t, options = {}) {
  const workers = [], sent = [];
  const lifecycle = new EventEmitter();
  const service = createShellMenuService('fake.exe', { ...options, lifecycle, spawn() {
    const worker = new EventEmitter();
    worker.stdin = new PassThrough(); worker.stdout = new PassThrough(); worker.stderr = new PassThrough();
    worker.stdin.on('data', data => sent.push({ worker, ...JSON.parse(data) }));
    worker.kill = () => { worker.killed = true; worker.killCount = (worker.killCount || 0) + 1; return true; };
    workers.push(worker);
    return worker;
  } });
  t.after(() => { service.cancel(); for (const worker of workers) worker.emit('exit', 0); });
  const show = mode => service.show({ parent: __dirname, paths: [], operation: 'copy' }, {}, mode);
  const reply = (index, value = {}, extra = {}) => {
    const { worker, id } = sent[index];
    worker.stdout.write(JSON.stringify({ id, ok: true, value, ...extra }) + '\n');
  };
  async function waitFor(count) {
    for (let i = 0; sent.length < count && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(sent.length, count, 'helper request count');
  }
  return { service, workers, sent, show, reply, waitFor, lifecycle };
}

const shortTimeouts = { validationMs: 30, clipboardMs: 30, workerMs: 30, shutdownMs: 30 };

// Bound even the red test: an implementation with no deadline must fail an
// assertion, rather than hold the test runner (and its remaining tests) forever.
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('request did not settle within 500ms')), 500);
    })]);
  } finally { clearTimeout(timer); }
}

function fakeTimers() {
  const jobs = [];
  let now = 0;
  return {
    jobs,
    setTimeout(callback, delay) {
      const timer = { callback, at: now + delay, cleared: false };
      jobs.push(timer);
      return timer;
    },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
    advance(delay) {
      now += delay;
      for (const timer of jobs) {
        if (!timer.cleared && timer.at <= now) { timer.cleared = true; timer.callback(); }
      }
    },
  };
}

for (const mode of ['show', 'drag', 'readClipboard', 'writeClipboard', 'completePaste', 'inspect', 'inspectDrag']) {
  test(`deadline releases hung ${mode} preparation and the next request gets a fresh worker`, async t => {
    const f = fixture(t, { timeouts: shortTimeouts });
    const rejected = assert.rejects(f.show(mode), { code: 'SHELL_TIMEOUT' });
    await f.waitFor(1);
    await bounded(rejected);
    assert.equal(f.service.pending, false);
    assert.equal(f.workers[0].killed, true);
    const next = f.show('readClipboard');
    await f.waitFor(2);
    assert.equal(f.workers.length, 2);
    f.reply(1, 'fresh');
    assert.equal(await bounded(next), 'fresh');
  });
}

test('deadline includes hung validation and revokes its queued requests', async t => {
  const f = fixture(t, { timeouts: shortTimeouts, validate: () => new Promise(() => {}) });
  const rejected = Promise.all(['writeClipboard', 'readClipboard', 'drag'].map((mode, index) =>
    assert.rejects(f.show(mode), { code: 'SHELL_TIMEOUT', phase: index ? 'queued' : 'validation', outcomeUncertain: false })));
  await bounded(rejected);
  assert.equal(f.service.pending, false);
  assert.equal(f.workers.length, 0);
});

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

test('close rejects active and queued requests and kills a blocked helper immediately', async t => {
  const f = fixture(t);
  const rejected = Promise.all(['readClipboard', 'completePaste', 'show'].map(mode =>
    assert.rejects(f.show(mode), { code: 'SHELL_CANCELLED' })));
  await f.waitFor(1);
  const closing = f.service.close();
  await rejected;
  assert.equal(f.workers[0].killed, true);
  assert.equal(f.service.pending, false);
  f.workers[0].emit('exit', 0);
  assert.deepEqual(await closing, [{ exited: true }]);
});

test('idle close allows graceful clipboard flush and returns an awaitable exit', async t => {
  const f = fixture(t);
  f.service.start();
  const closing = f.service.close();
  assert.equal(f.workers[0].stdin.writableEnded, true);
  assert.equal(f.workers[0].killed, undefined);
  assert.equal(f.service.close(), closing);
  f.workers[0].emit('exit', 0);
  assert.deepEqual(await bounded(closing), [{ exited: true }]);
  await assert.rejects(f.show('readClipboard'), { code: 'SHELL_CLOSED' });
  assert.throws(() => f.service.start(), { code: 'SHELL_CLOSED' });
});

test('clipboard timeout rejects FIFO and reserved UI without replaying any mutation', async t => {
  const timers = fakeTimers(), f = fixture(t, { timers, timeouts: shortTimeouts });
  const rejected = Promise.all(['writeClipboard', 'completePaste', 'show'].map((mode, index) =>
    assert.rejects(f.show(mode), error => {
      assert.equal(error.code, 'SHELL_TIMEOUT');
      assert.equal(error.mode, mode);
      assert.equal(error.phase, index ? 'queued' : 'clipboard');
      assert.equal(error.outcomeUncertain, !index);
      assert.equal(error.retryable, false);
      assert.equal(error.timeoutMs, 30);
      return true;
    })));
  await f.waitFor(1);
  timers.advance(30);
  await bounded(rejected);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sent.length, 1, 'the service must never retry a clipboard/file operation');
  assert.equal(f.service.pending, false);
  assert.equal(f.workers[0].killed, true);
});

for (const late of ['resolve', 'reject']) test(`timed out validation cannot ${late} into a replacement request`, async t => {
  let resolveValidation, rejectValidation, signal;
  const timers = fakeTimers();
  const f = fixture(t, { timers, timeouts: shortTimeouts, validate: (_, context) => {
    signal = context.signal;
    return new Promise((resolve, reject) => { resolveValidation = resolve; rejectValidation = reject; });
  } });
  f.service.start(); // Timeout must also retire a prewarmed helper.
  const rejected = assert.rejects(f.show('writeClipboard'), { code: 'SHELL_TIMEOUT' });
  await new Promise(resolve => setImmediate(resolve));
  const oldTimer = timers.jobs.at(-1);
  timers.advance(30);
  await bounded(rejected);
  assert.equal(signal.aborted, true);
  assert.equal(f.workers[0].killed, true);
  const next = f.show('readClipboard');
  await f.waitFor(1);
  if (late === 'resolve') resolveValidation({ parent: __dirname, paths: [] });
  else rejectValidation(new Error('late filesystem error'));
  oldTimer.callback(); // A callback that was already queued when cleared.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.workers.length, 2);
  assert.equal(f.workers[1].killed, undefined);
  assert.equal(f.sent.length, 1);
  f.reply(0, 'replacement');
  assert.equal(await bounded(next), 'replacement');
});

test('completed and retired request timers and stale worker events cannot poison fresh work', async t => {
  const timers = fakeTimers(), f = fixture(t, { timers, timeouts: shortTimeouts });
  const first = f.show('readClipboard');
  await f.waitFor(1);
  const completedTimer = timers.jobs.at(-1);
  f.reply(0);
  await first;
  const rejected = assert.rejects(f.show('readClipboard'), { code: 'SHELL_TIMEOUT' });
  await f.waitFor(2);
  const expiredTimer = timers.jobs.at(-1);
  completedTimer.callback();
  assert.equal(f.workers[0].killed, undefined);
  timers.advance(30);
  await rejected;
  const next = f.show('readClipboard');
  await f.waitFor(3);
  expiredTimer.callback();
  f.workers[0].stdin.emit('error', new Error('late pipe'));
  f.workers[0].stdout.emit('error', new Error('late stdout'));
  f.workers[0].stderr.emit('error', new Error('late stderr'));
  f.workers[0].emit('error', new Error('late worker'));
  f.workers[0].emit('exit', 1);
  f.reply(1, 'late response');
  assert.equal(f.workers[1].killed, undefined);
  f.reply(2, 'fresh');
  assert.equal(await bounded(next), 'fresh');
});

for (const mode of ['show', 'drag']) {
  for (const phase of ['interactive', 'committing']) test(`${mode} ${phase} does not abort a legitimate user choice or file transfer`, async t => {
    const timers = fakeTimers(), f = fixture(t, { timers, timeouts: shortTimeouts });
    const request = f.show(mode);
    await f.waitFor(1);
    const prepTimer = timers.jobs.at(-1);
    const { worker, id, reportProgress } = f.sent[0];
    assert.equal(reportProgress, true);
    worker.stdout.write(JSON.stringify({ id, phase }) + '\n');
    timers.advance(24 * 60 * 60 * 1000);
    prepTimer.callback();
    assert.equal(worker.killed, undefined);
    assert.equal(f.service.pending, true);
    await assert.rejects(f.show('readClipboard'), { code: 'SHELL_BUSY' });
    f.reply(0, 'user finished');
    assert.equal(await bounded(request), 'user finished');
  });
}

test('a stale phase cannot disable the deadline of a different request', async t => {
  const timers = fakeTimers(), f = fixture(t, { timers, timeouts: shortTimeouts });
  const first = f.show('show');
  await f.waitFor(1); f.reply(0); await first;
  const rejected = assert.rejects(f.show('drag'), { code: 'SHELL_TIMEOUT' });
  await f.waitFor(2);
  const { worker, id } = f.sent[0];
  worker.stdout.write(JSON.stringify({ id, phase: 'committing' }) + '\n');
  timers.advance(30);
  await bounded(rejected);
  assert.equal(worker.killed, true);
});

for (const action of ['cancel', 'close']) test(`${action} still revokes interactive and committing phases without replay`, async t => {
  for (const phase of ['interactive', 'committing']) {
    const timers = fakeTimers(), f = fixture(t, { timers, timeouts: shortTimeouts });
    const rejected = assert.rejects(f.show('drag'), { code: 'SHELL_CANCELLED' });
    await f.waitFor(1);
    f.workers[0].stdout.write(JSON.stringify({ id: f.sent[0].id, phase }) + '\n');
    const closing = f.service[action]();
    await bounded(rejected);
    assert.equal(f.service.pending, false);
    assert.equal(f.workers[0].killed, true);
    f.workers[0].emit('exit', 0);
    if (closing) await bounded(closing);
    assert.equal(f.sent.length, 1);
  }
});

test('clipboard cannot escape its deadline using an interactive phase', async t => {
  const f = fixture(t);
  const rejected = assert.rejects(f.show('readClipboard'), { code: 'SHELL_PROTOCOL_ERROR' });
  await f.waitFor(1);
  f.workers[0].stdout.write(JSON.stringify({ id: f.sent[0].id, phase: 'interactive' }) + '\n');
  await bounded(rejected);
  assert.equal(f.workers[0].killed, true);
});

test('idle close has a bounded kill fallback, then process exit retries every owned live helper', async t => {
  const timers = fakeTimers(), f = fixture(t, { timers, timeouts: shortTimeouts });
  f.service.start();
  const old = f.workers[0];
  f.service.cancel();
  f.service.start();
  const current = f.workers[1];
  const closing = f.service.close();
  assert.equal(current.stdin.writableEnded, true);
  assert.equal(current.killed, undefined);
  timers.advance(30);
  assert.deepEqual(await bounded(closing), [{ exited: false }, { exited: false }]);
  assert.equal(current.killed, true);
  const kills = f.workers.map(worker => worker.killCount);
  f.lifecycle.emit('exit');
  assert.equal(old.killCount, kills[0] + 1);
  assert.equal(current.killCount, kills[1] + 1);
});

test('graceful shutdown clears its timer and ownership hook only after exit', async t => {
  const timers = fakeTimers(), f = fixture(t, { timers, timeouts: shortTimeouts });
  f.service.start();
  assert.equal(f.lifecycle.listenerCount('exit'), 1);
  const closing = f.service.close();
  const shutdownTimer = timers.jobs.at(-1);
  f.workers[0].emit('exit', 0);
  await bounded(closing);
  assert.equal(shutdownTimer.cleared, true);
  assert.equal(f.lifecycle.listenerCount('exit'), 0);
  timers.advance(30);
  shutdownTimer.callback(); // Already queued before exit cleared the timer.
  assert.equal(f.workers[0].killed, undefined);
});

test('process exit kills its prewarmed helper synchronously without waiting for timers', async t => {
  const f = fixture(t);
  f.service.start();
  f.lifecycle.emit('exit');
  assert.equal(f.workers[0].killed, true);
  await assert.rejects(f.show('readClipboard'), { code: 'SHELL_CLOSED' });
});

test('close during validation revokes late completion and cannot start another helper', async t => {
  let complete, signal;
  const f = fixture(t, { validate: (_, context) => {
    signal = context.signal;
    return new Promise(resolve => { complete = resolve; });
  } });
  const rejected = Promise.all(['writeClipboard', 'readClipboard', 'drag'].map(mode =>
    assert.rejects(f.show(mode), { code: 'SHELL_CANCELLED' })));
  await new Promise(resolve => setImmediate(resolve));
  await f.service.close();
  await bounded(rejected);
  assert.equal(signal.aborted, true);
  complete({ parent: __dirname, paths: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.workers.length, 0);
  await assert.rejects(f.show('readClipboard'), { code: 'SHELL_CLOSED' });
});

test('a throwing kill never leaves active and queued promises reserved', async t => {
  const timers = fakeTimers(), f = fixture(t, { timers, timeouts: shortTimeouts });
  const rejected = Promise.all(['readClipboard', 'completePaste', 'show'].map(mode =>
    assert.rejects(f.show(mode), { code: 'SHELL_TIMEOUT' })));
  await f.waitFor(1);
  f.workers[0].kill = () => { throw new Error('kill unavailable'); };
  assert.doesNotThrow(() => timers.advance(30));
  await bounded(rejected);
  assert.equal(f.service.pending, false);
});

test('invalid timeout injection cannot silently turn into a one millisecond deadline', () => {
  for (const value of [0, -1, Infinity, NaN, 2147483648]) {
    assert.throws(() => createShellMenuService('fake.exe', { timeouts: { workerMs: value } }), RangeError);
  }
});

test('a stale stdin write callback cannot retire the same helper serving the next request', async t => {
  const f = fixture(t);
  f.service.start();
  const worker = f.workers[0], write = worker.stdin.write.bind(worker.stdin);
  let lateCallback;
  worker.stdin.write = (payload, callback) => { lateCallback = callback; return write(payload); };
  const first = f.show('readClipboard');
  await f.waitFor(1);
  const oldCallback = lateCallback;
  f.reply(0); await first;
  const next = f.show('readClipboard');
  await f.waitFor(2);
  oldCallback(new Error('stale write callback'));
  assert.equal(worker.killed, undefined);
  f.reply(1, 'fresh');
  assert.equal(await bounded(next), 'fresh');
});

test('a failed spawn close event removes ownership without waiting for a nonexistent exit', async t => {
  const f = fixture(t);
  const rejected = assert.rejects(f.show('readClipboard'), { code: 'ENOENT' });
  await f.waitFor(1);
  f.workers[0].emit('error', Object.assign(new Error('missing executable'), { code: 'ENOENT' }));
  f.workers[0].emit('close', -1);
  await bounded(rejected);
  assert.equal(f.lifecycle.listenerCount('exit'), 0);
  assert.deepEqual(await bounded(f.service.close()), []);
});

test('process.exit executes the ownership kill hook even when graceful shutdown timers cannot run', () => {
  const { spawnSync } = require('node:child_process');
  const script = `
    const { EventEmitter } = require('node:events');
    const { PassThrough } = require('node:stream');
    const { createShellMenuService } = require(${JSON.stringify(require.resolve('./shell-menu.cjs'))});
    const worker = new EventEmitter();
    worker.stdin = new PassThrough(); worker.stdout = new PassThrough(); worker.stderr = new PassThrough();
    worker.kill = () => { require('node:fs').writeSync(1, 'owned-helper-killed'); return true; };
    const service = createShellMenuService('fake.exe', { spawn: () => worker });
    service.start(); service.close(); process.exit(0);
  `;
  // Only a purpose-built Node child and fake helper are used; no user process.
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', windowsHide: true, timeout: 2000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'owned-helper-killed');
});
