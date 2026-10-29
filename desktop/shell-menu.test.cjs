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
