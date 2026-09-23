'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
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

test('cancel releases a hung shell request; late events cannot reject a replacement worker', async () => {
  const workers = [];
  const service = createShellMenuService('fake.exe', { spawn() {
    const worker = new EventEmitter();
    worker.stdin = new PassThrough(); worker.stdout = new PassThrough(); worker.stderr = new PassThrough();
    worker.kill = () => { worker.killed = true; };
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

test('real x64 shell COM enumerates file, folder, multiple selection and background menus on an STA', { timeout: 60000 }, () => {
  const build = spawnSync(process.execPath, [path.join(__dirname, 'build-shell-helper.cjs')], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  const requests = [[first], [child], [first, second], []].map((paths, index) => ({ id: String(index), mode: 'inspect', parent: folder, paths }));
  // A malformed selection must not poison the persistent worker's next request.
  requests.splice(2, 0, { id: 'invalid', mode: 'inspect', parent: folder, paths: [path.join(folder, 'absent')] });
  requests.push({ id: 'drag', mode: 'inspectDrag', parent: folder, paths: [first, child] });
  requests.push({ id: 'clipboard', mode: 'completePaste', sequence: 0, completed: [] });
  const result = spawnSync(path.join(__dirname, 'native', 'bin', 'Quadpane.Shell.exe'), [], {
    input: requests.map(request => JSON.stringify(request)).join('\n') + '\n', encoding: 'utf8', windowsHide: true, timeout: 30000,
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
