'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const vm = require('node:vm');
const { validateMenuRequest, createShellMenuService } = require('./shell-menu.cjs');
const root = path.join(__dirname, '..', '.checks', 'shell-menu-tests');
fs.mkdirSync(root, { recursive: true });
const folder = fs.mkdtempSync(path.join(root, 'run-'));
const first = path.join(folder, '한글 & space.txt');
const second = path.join(folder, 'second.txt');
const child = path.join(folder, 'directory');
fs.writeFileSync(first, 'one'); fs.writeFileSync(second, 'two'); fs.mkdirSync(child);

test('shell menu accepts background and same-parent selections, rejects malformed/mixed requests', async () => {
  assert.deepEqual(await validateMenuRequest({ parent: folder, paths: [] }), { parent: folder, paths: [], extended: false });
  assert.deepEqual((await validateMenuRequest({ parent: folder, paths: [first, second, child] })).paths, [first, second, child]);
  for (const request of [null, { parent: folder, paths: 'bad' }, { parent: folder, paths: [path.join(child, 'nested')] },
    { parent: folder, paths: [first, 'https://example.com'] }, { parent: first, paths: [] },
    { parent: folder, paths: [path.join(folder, 'absent')] }]) await assert.rejects(validateMenuRequest(request));
});

test('helper spawn failure is reported and service can retry without a stuck pending menu', async () => {
  const service = createShellMenuService(path.join(folder, 'absent.exe'));
  await assert.rejects(service.show({ parent: folder, paths: [first] }, {}));
  await assert.rejects(service.show({ parent: folder, paths: [first] }, {}));
  service.close();
});

test('drag dispatch does not wait on redundant filesystem reads; native failures still propagate', async () => {
  let reads = 0;
  const sandbox = { module: { exports: {} }, process, AbortController, setTimeout, clearTimeout,
    require(name) {
      if (name === 'node:fs/promises') return { stat() { reads++; throw new Error('Slow filesystem'); }, lstat() { reads++; throw new Error('Slow filesystem'); } };
      return require(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'shell-menu.cjs'), 'utf8'), sandbox);
  const worker = new EventEmitter();
  worker.stdin = new PassThrough(); worker.stdout = new PassThrough(); worker.stderr = new PassThrough();
  worker.kill = () => { queueMicrotask(() => worker.emit('exit', 0)); return true; };
  worker.stdin.on('finish', () => queueMicrotask(() => worker.emit('exit', 0)));
  let payload;
  worker.stdin.on('data', chunk => {
    payload = JSON.parse(String(chunk));
    worker.stdout.write(JSON.stringify({ id: payload.id, ok: false, error: 'Native source missing' }) + '\n');
  });
  const service = sandbox.module.exports.createShellMenuService('fake.exe', { spawn: () => worker });
  try {
    await assert.rejects(service.show({ parent: folder, paths: [first] }, {}, 'drag'));
    assert.equal(reads, 0);
    assert.equal(payload.mode, 'drag');
    assert.deepEqual(payload.paths, [first]);
    payload = undefined;
    await assert.rejects(service.show({ parent: folder, paths: [path.join(child, 'nested')] }, {}, 'drag'), /share its parent/u);
    assert.equal(payload, undefined, 'mixed-parent selection must not reach native code');
  } finally { await service.close(); }
});

test('cancel releases a hung shell request; late events cannot reject a replacement worker', async () => {
  const workers = [];
  const service = createShellMenuService('fake.exe', { spawn() {
    const worker = new EventEmitter();
    worker.stdin = new PassThrough(); worker.stdout = new PassThrough(); worker.stderr = new PassThrough();
    worker.kill = () => { worker.killed = true; queueMicrotask(() => worker.emit('exit', 1)); };
    workers.push(worker); return worker;
  } });
  const pending = service.show({ parent: folder, paths: [first] }, {});
  const rejected = assert.rejects(pending, /cancelled/u);
  while (!workers.length) await new Promise(resolve => setImmediate(resolve));
  service.cancel(); await rejected;
  assert.equal(workers[0].killed, true);
  const next = service.show({ parent: folder, paths: [second] }, {});
  while (workers.length < 2) await new Promise(resolve => setImmediate(resolve));
  workers[0].stdin.emit('error', new Error('stale pipe error'));
  workers[0].emit('exit', 1);
  const request = JSON.parse(workers[1].stdin.read().toString());
  workers[1].stdout.write(JSON.stringify({ id: request.id, ok: true, value: { action: 'cancel' } }) + '\n');
  assert.deepEqual(await next, { action: 'cancel' });
  service.cancel();
});

function eofFixture(t) {
  const workers = [], sent = [], jobs = [];
  let now = 0;
  const timers = {
    setTimeout(callback, delay) { const job = { callback, at: now + delay }; jobs.push(job); return job; },
    clearTimeout(job) { if (job) job.cleared = true; },
    advance(ms) {
      now += ms;
      for (const job of jobs) if (!job.cleared && job.at <= now) { job.cleared = true; job.callback(); }
    },
  };
  const service = createShellMenuService('private-fixture.exe', {
    timers, lifecycle: new EventEmitter(), validate: () => ({}),
    timeouts: { eofExitMs: 100 },
    spawn() {
      const worker = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kills: 0,
      });
      worker.kill = () => { worker.kills++; return false; };
      worker.stdin.on('data', chunk => sent.push({ worker, ...JSON.parse(chunk) }));
      workers.push(worker);
      return worker;
    },
  });
  t.after(async () => {
    for (const worker of workers) worker.emit('exit', 1, null);
    await service.close();
  });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  return {
    service, timers, jobs, workers, sent, tick,
    show: (mode = 'drag') => service.show({}, {}, mode),
    phase(value) { const { worker, id } = sent.at(-1); worker.stdout.write(JSON.stringify({ id, phase: value }) + '\n'); },
  };
}

for (const scenario of [
  { mode: 'drag', phase: 'interactive', exitCode: 2, code: 'SHELL_CANCELLED' },
  { mode: 'drag', phase: 'interactive', exitCode: 2, code: 'SHELL_CANCELLED', event: 'close' },
  { mode: 'drag', phase: 'committing', exitCode: 2, code: 'SHELL_HELPER_EXITED' },
  { mode: 'drag', phase: 'interactive', exitCode: 1, code: 'SHELL_HELPER_EXITED' },
  { mode: 'drag', phase: 'interactive', exitCode: 0, code: 'SHELL_HELPER_EXITED' },
  { mode: 'drag', phase: 'interactive', exitCode: 2, signal: 'SIGTERM', code: 'SHELL_HELPER_EXITED' },
  { mode: 'show', phase: 'interactive', exitCode: 2, code: 'SHELL_HELPER_EXITED' },
]) test(`clean EOF before process exit preserves classification: ${JSON.stringify(scenario)}`, async t => {
  const f = eofFixture(t);
  let settled = false;
  const pending = f.show(scenario.mode);
  pending.then(() => { settled = true; }, () => { settled = true; });
  const result = pending.catch(error => error);
  await f.tick();
  const worker = f.workers[0];
  f.phase(scenario.phase);
  worker.stdout.end();
  await f.tick();
  assert.equal(settled, false, 'clean EOF must allow the exit event to supply its classification');
  assert.equal(worker.kills, 0);
  assert.equal(worker.stdin.writableEnded, false);
  const staleCallbacks = f.jobs.filter(job => !job.cleared).map(job => job.callback);
  worker.emit(scenario.event || 'exit', scenario.exitCode, scenario.signal || null);
  const error = await result;
  assert.equal(error.code, scenario.code);
  assert.equal(error.exitCode, scenario.exitCode);
  assert.equal(worker.kills, 0, 'normal EOF and exit must not trigger termination');
  const next = f.show('readClipboard');
  await f.tick();
  for (const callback of staleCallbacks) callback();
  worker.stdout.emit('close');
  assert.equal(f.workers.length, 2);
  assert.equal(f.workers[1].kills, 0);
  const { worker: replacement, id } = f.sent.at(-1);
  replacement.stdout.write(JSON.stringify({ id, ok: true, value: 'fresh' }) + '\n');
  assert.equal(await next, 'fresh');
  assert.equal(f.sent.length, 2, 'no automatic replay');
});

for (const phase of ['interactive', 'committing']) test(`clean EOF without exit has a bounded wait and retains ${phase} ownership`, async t => {
  const f = eofFixture(t);
  const result = f.show().catch(error => error);
  await f.tick();
  const worker = f.workers[0];
  f.phase(phase);
  worker.stdout.end();
  await f.tick();
  f.timers.advance(99);
  assert.equal(f.service.pending, true);
  worker.stdout.emit('close'); // A second EOF notification must not restart the grace.
  f.timers.advance(1);
  assert.equal(f.service.pending, false);
  const error = await result;
  assert.equal(error.code, 'SHELL_DISCONNECTED');
  assert.equal(error.phase, phase);
  assert.equal(error.outcomeUncertain, true);
  assert.equal(error.retryable, false);
  assert.throws(() => f.service.start(), { code: 'SHELL_RECOVERY_FAILED' });
  assert.equal(worker.kills, phase === 'committing' ? 0 : 1);
  assert.equal(worker.stdin.writableEnded, phase !== 'committing');
  if (phase === 'committing') assert.deepEqual(await f.service.cancel(), [{ exited: false }]);
});

for (const phase of ['interactive', 'committing']) test(`stream error during ${phase} EOF grace stays immediate and cannot become cancellation`, async t => {
  const f = eofFixture(t);
  const result = f.show().catch(error => error);
  await f.tick();
  const worker = f.workers[0];
  f.phase(phase);
  worker.stdout.end();
  await f.tick();
  worker.stdout.emit('error', Object.assign(new Error('fixture reset'), { code: 'ECONNRESET' }));
  assert.equal(f.service.pending, false, 'stream errors must not wait for the EOF grace timer');
  const error = await result;
  assert.equal(error.code, 'SHELL_DISCONNECTED');
  assert.equal(error.transportCode, 'ECONNRESET');
  assert.equal(error.phase, phase);
  assert.equal(error.outcomeUncertain, true);
  assert.equal(worker.kills, phase === 'committing' ? 0 : 1);
  assert.equal(worker.stdin.writableEnded, phase !== 'committing');
  worker.emit('exit', 2, null);
  f.timers.advance(100);
  assert.equal(error.code, 'SHELL_DISCONNECTED');
});

test('cancel during committing EOF grace cannot end stdin or terminate unconfirmed work', async t => {
  const f = eofFixture(t);
  const result = f.show().catch(error => error);
  await f.tick();
  const worker = f.workers[0];
  f.phase('committing');
  worker.stdout.end();
  await f.tick();
  assert.deepEqual(await f.service.cancel(), [{ exited: false }]);
  await result;
  f.timers.advance(1000);
  assert.equal(worker.kills, 0);
  assert.equal(worker.stdin.writableEnded, false);
  assert.equal(worker.stdin.destroyed, false);
  assert.throws(() => f.service.start(), { code: 'SHELL_RECOVERY_FAILED' });
});

test('private child clean stdout EOF before watchdog exit 2 is cancellation without termination', { timeout: 5000 }, async t => {
  const events = [];
  let worker, exited, kills = 0;
  const script = `
    const deadline = setTimeout(() => process.exit(90), 2000);
    process.stdin.once('data', data => {
      const { id } = JSON.parse(data);
      process.stdout.end(JSON.stringify({ id, phase: 'interactive' }) + '\\n', () => {
        setTimeout(() => { clearTimeout(deadline); process.exit(2); }, 20);
      });
    });
  `;
  const service = createShellMenuService('private-fixture', {
    lifecycle: new EventEmitter(), validate: () => ({}),
    spawn() {
      worker = spawn(process.execPath, ['-e', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      worker.stdout.once('end', () => events.push('end'));
      worker.once('exit', () => events.push('exit'));
      exited = new Promise(resolve => worker.once('close', resolve));
      // The private child exits itself; never terminate even a test process.
      worker.kill = () => { kills++; return false; };
      return worker;
    },
  });
  t.after(async () => { if (exited) await exited; await service.close(); });
  await assert.rejects(service.show({}, {}, 'drag'), { code: 'SHELL_CANCELLED', exitCode: 2 });
  await exited;
  assert.deepEqual(events, ['end', 'exit']);
  assert.equal(kills, 0);
  assert.equal(service.pending, false);
  assert.deepEqual(await service.cancel(), []);
});

test('real x64 shell COM enumerates file, folder, multiple selection and background menus on an STA', { timeout: 60000 }, async t => {
  // npm pretest builds once before parallel test workers can open this EXE.
  const helper = path.join(__dirname, 'native', 'bin', 'Quadpane.Shell.exe');
  assert.ok(fs.existsSync(helper), 'Run npm run build:native before invoking this test directly');
  const requests = [[first], [child], [first, second], []].map((paths, index) => ({ id: String(index), mode: 'inspect', parent: folder, paths }));
  // A malformed selection must not poison the persistent worker's next request.
  requests.splice(2, 0, { id: 'invalid', mode: 'inspect', parent: folder, paths: [path.join(folder, 'absent')] });
  requests.push({ id: 'drag', mode: 'inspectDrag', parent: folder, paths: [first, child] });
  requests.push({ id: 'clipboard', mode: 'completePaste', sequence: 0, completed: [] });
  // Match the live parent protocol: EOF means the parent disconnected, so keep
  // stdin open until every response arrives instead of racing the EOF watchdog.
  const result = await new Promise(resolve => {
    const worker = spawn(helper, [], {
      windowsHide: true, timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    t.after(() => { if (worker.exitCode === null && !worker.killed) worker.kill(); });
    let stdout = '', stderr = '', error;
    worker.stdout.setEncoding('utf8'); worker.stderr.setEncoding('utf8');
    worker.stdout.on('data', chunk => {
      stdout += chunk;
      if ((stdout.match(/\n/gu) || []).length >= requests.length && !worker.stdin.writableEnded) worker.stdin.end();
    });
    worker.stderr.on('data', chunk => { stderr += chunk; });
    worker.stdin.on('error', value => { error = value; });
    worker.on('error', value => { error = value; });
    worker.once('close', status => resolve({ status, stdout, stderr, error }));
    worker.stdin.write(requests.map(request => JSON.stringify(request)).join('\n') + '\n');
  });
  assert.equal(result.status, 0, `${result.error || ''}\n${result.stderr}`);
  const responses = result.stdout.trim().split(/\r?\n/u).map(line => JSON.parse(line.replace(/^\uFEFF/u, '')));
  assert.equal(responses.length, requests.length);
  for (const response of responses) {
    if (response.id === 'invalid') { assert.equal(response.ok, false); continue; }
    assert.equal(response.ok, true, JSON.stringify(response));
    if (response.id === 'clipboard') { assert.equal(response.value.changed, false); continue; }
    if (response.id === 'drag') { assert.deepEqual(response.value.paths, [first, child]); assert.equal(response.value.allowedEffects, 3); continue; }
    assert.ok(response.value.entries.some(entry => entry.label), JSON.stringify(response));
    if (response.id !== '3') assert.ok(response.value.entries.some(entry => entry.verb === 'copy'), JSON.stringify(response));
  }
  fs.writeFileSync(path.join(folder, 'shell-evidence.json'), JSON.stringify(responses, null, 2));
});

test('optimized clipboard completion reports NONE then MOVE, never requesting a second deletion', () => {
  const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const executable = path.join(folder, 'ClipboardContractTest.exe');
  const build = spawnSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/main:ClipboardContractTest',
    '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll', `/out:${executable}`,
    path.join(__dirname, 'native', 'ShellMenu.cs'), path.join(__dirname, 'native', 'ClipboardContractTest.cs')], { encoding: 'utf8', windowsHide: true });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  const result = spawnSync(executable, [], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
