'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const operations = require('./file-operations.cjs');
const { validateTransfer, copyFileRecord, transferError, createNativeMover } = operations;
const nativeMove = process.env.PANE_TEST_MOVE_HELPER
  ? createNativeMover({ executable: path.resolve(process.env.PANE_TEST_MOVE_HELPER) }) : operations.nativeMove;
const createTransferService = (options = {}) => operations.createTransferService({ nativeMove, ...options });
const base = path.join(__dirname, '..', '.checks', 'file-operation-tests');

async function fixture() {
  await fs.mkdir(base, { recursive: true });
  const directory = await fs.mkdtemp(path.join(base, 'run-'));
  const source = path.join(directory, 'source');
  const destination = path.join(directory, 'destination');
  await fs.mkdir(source);
  await fs.mkdir(destination);
  return { directory, source, destination };
}
async function missing(filename) { await assert.rejects(fs.lstat(filename), { code: 'ENOENT' }); }

async function withReadLock(filename, action) {
  const { spawn } = require('node:child_process');
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Read access is allowed; deleting/renaming the open file is deliberately denied.
  const script = String.raw`
    $ErrorActionPreference = 'Stop'
    $request = [Console]::In.ReadLine() | ConvertFrom-Json
    $handle = [IO.File]::Open($request.path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try { [Console]::Out.WriteLine('ready'); [Console]::In.ReadLine() | Out-Null }
    finally { $handle.Dispose() }
  `;
  const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = new Promise(resolve => child.once('close', resolve));
  child.stdin.on('error', () => {});
  let output = '', errors = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { errors += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Lock fixture did not start')); }, 10000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('close', () => { clearTimeout(timeout); reject(new Error(`Lock fixture exited: ${errors}`)); });
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.includes('ready')) { clearTimeout(timeout); resolve(); }
      });
      child.stdin.write(`${JSON.stringify({ path: filename })}\n`);
    });
    return await action();
  } finally {
    child.stdin.end('\n');
    await closed;
  }
}

test('validation rejects protocols, devices, relative paths, aliases and malformed requests', () => {
  for (const source of [null, 44, 'C:relative', 'https://x', '\\\\.\\C:', 'C:\\work\\name.', 'C:\\work\\NUL.txt']) {
    assert.throws(() => validateTransfer({ sources: [source], destination: 'C:\\output', operation: 'copy' }));
  }
  assert.throws(() => validateTransfer({ sources: [], destination: 'C:\\output', operation: 'move' }));
  assert.throws(() => validateTransfer({ sources: ['C:\\work'], destination: 'C:\\output', operation: 'delete' }));
  assert.equal(validateTransfer({ sources: ['C:\\work', 'c:\\WORK'], destination: 'D:/output', operation: 'copy' }).sources.length, 1);
});

for (const operation of ['copy', 'move']) for (const childFirst of [false, true]) {
  test(`${operation} collapses duplicate and ancestor selections with childFirst=${childFirst}`, async () => {
    const f = await fixture();
    const folder = path.join(f.source, 'folder');
    const child = path.join(folder, 'nested', 'child.txt');
    await fs.mkdir(path.dirname(child), { recursive: true });
    await fs.writeFile(child, 'keep hierarchy');
    const sources = childFirst ? [child, folder, folder] : [folder, folder, child];
    const result = await createTransferService().transfer({ sources, destination: f.destination, operation });
    assert.equal(result.failed.length, 0, JSON.stringify(result));
    assert.equal(result.completed.length, 1, JSON.stringify(result));
    assert.deepEqual(result.skipped.map(item => [item.source, item.code]), [[child, 'PARENT_SELECTED']]);
    assert.equal(await fs.readFile(path.join(f.destination, 'folder', 'nested', 'child.txt'), 'utf8'), 'keep hierarchy');
    assert.deepEqual(await fs.readdir(f.destination), ['folder']);
    if (operation === 'copy') assert.equal(await fs.readFile(child, 'utf8'), 'keep hierarchy');
    else await missing(folder);
  });
}

test('a conflicting selected parent does not extract its selected child', async () => {
  const f = await fixture();
  const folder = path.join(f.source, 'folder');
  const child = path.join(folder, 'child.txt');
  await fs.mkdir(folder);
  await fs.writeFile(child, 'keep inside source');
  await fs.mkdir(path.join(f.destination, 'folder'));
  const result = await createTransferService().transfer({ sources: [child, folder], destination: f.destination, operation: 'move' });
  assert.equal(result.completed.length, 0, JSON.stringify(result));
  assert.deepEqual(result.skipped.map(item => item.code).sort(), ['EEXIST', 'PARENT_SELECTED']);
  assert.equal(await fs.readFile(child, 'utf8'), 'keep inside source');
  assert.deepEqual(await fs.readdir(f.destination), ['folder']);
});

async function nativeResponse(output, exitCode = 0, stderr = '', runtime = process, onSpawn = () => {}) {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const vm = require('node:vm');
  const module = { exports: {} };
  const spawn = executable => {
    onSpawn(executable);
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      child.stdout.end(output);
      child.stderr.end(stderr);
      child.emit('close', exitCode, null);
    });
    return child;
  };
  vm.runInNewContext(await fs.readFile(path.join(__dirname, 'file-operations.cjs'), 'utf8'), {
    module, process: runtime, __dirname, require: name => name === 'node:child_process' ? { spawn } : require(name),
  });
  return module.exports.nativeMove('C:\\fixture\\source', 'C:\\fixture\\target', 'file');
}

test('mover uses the local build in Electron development and extraResources in packaged Electron', async () => {
  for (const defaultApp of [true, false]) {
    const resourcesPath = 'C:\\private-electron\\resources';
    const expected = defaultApp ? path.join(__dirname, 'native', 'bin', 'Quadpane.Move.exe')
      : path.join(resourcesPath, 'native', 'Quadpane.Move.exe');
    await nativeResponse('{"ok":true}', 0, '', { platform: 'win32', env: process.env, resourcesPath, defaultApp },
      executable => assert.equal(executable, expected));
  }
});

test('native replies require an explicit boolean success and a successful process exit', async () => {
  await nativeResponse('\uFEFF{"ok":true}\r\n');
  for (const output of ['', 'not json', 'null', '[]', '{"ok":"false"}', '{"ok":1}', '{"ok":false}']) {
    await assert.rejects(nativeResponse(output), { code: 'TRANSFER_FAILED' }, output);
  }
  await assert.rejects(nativeResponse('{"ok":true}', 1, 'native transport failed'), error => {
    assert.equal(error.code, 'TRANSFER_FAILED');
    assert.equal(error.exitCode, 1);
    assert.match(error.nativeError, /native transport failed/);
    return true;
  });
});

test('a failed process exit cannot turn an uncertain mutation into a retryable EXDEV or skipped conflict', async () => {
  for (const win32 of [17, 80, 183]) {
    await assert.rejects(nativeResponse(JSON.stringify({ ok: false, win32, message: 'unconfirmed failure' }), 1), error => {
      assert.equal(error.code, 'TRANSFER_FAILED');
      assert.equal(error.win32, win32);
      assert.equal(error.exitCode, 1);
      return true;
    });
  }
});

function simulatedMover(replies) {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const calls = [];
  const move = createNativeMover({ executable: 'C:\\private-fixture\\Quadpane.Move.exe', spawn(executable, args, options) {
    const reply = replies[calls.length];
    assert.ok(reply, 'Unexpected mutation replay');
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    calls.push({ executable, args, options });
    process.nextTick(() => {
      if (!reply.launchError) child.emit('spawn');
      if (reply.error || reply.launchError) child.emit('error', Object.assign(new Error('fixture spawn error'), {
        code: reply.error || reply.launchError,
      }));
      child.stdout.end(reply.output || '');
      child.stderr.end();
      child.emit('close', reply.exitCode ?? 0, reply.signal || null);
    });
    return child;
  } });
  return { move, calls };
}

test('missing helper falls back only when no process started', async () => {
  const { move, calls } = simulatedMover([{ launchError: 'ENOENT' }, { output: '{"ok":true}' }]);
  await move('C:\\private-fixture\\a', 'C:\\private-fixture\\b', 'file');
  assert.equal(calls.length, 2);
  assert.match(calls[0].executable, /Quadpane\.Move\.exe$/u);
  assert.match(calls[1].executable, /powershell\.exe$/u);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[1].options.windowsHide, true);
});

test('native errors, malformed responses, abnormal exits and errors after launch never fall back', async () => {
  for (const reply of [
    { output: '{"ok":false,"win32":2}' },
    { output: 'lost response' },
    { output: '{"ok":true}', exitCode: 1 },
    { output: '{"ok":false,"win32":17}', exitCode: 1 },
    { output: '{"ok":true}', signal: 'SIGTERM' },
    { error: 'ENOENT' },
    { launchError: 'EACCES' },
  ]) {
    const { move, calls } = simulatedMover([reply]);
    await assert.rejects(move('C:\\private-fixture\\a', 'C:\\private-fixture\\b', 'file'));
    assert.equal(calls.length, 1, JSON.stringify(reply));
  }
});

test('cross-volume tree uses its existing single-process path directly without probing the helper', async () => {
  const { move, calls } = simulatedMover([{ output: '{"ok":false,"win32":32}' }]);
  await assert.rejects(move('C:\\private-fixture\\a', 'D:\\private-fixture\\b', 'tree'), { code: 'EBUSY' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].executable, /powershell\.exe$/u);
});

test('copy publication and file/directory moves support paths longer than MAX_PATH', async () => {
  const f = await fixture();
  // Exceed MAX_PATH even in a short CI checkout, with each component below 255.
  const destination = path.join(f.destination, ...Array(3).fill('long-'.repeat(20)));
  await fs.mkdir(destination, { recursive: true });
  assert.ok(destination.length > 260);
  const file = path.join(f.source, 'long-path.txt');
  await fs.writeFile(file, 'long path bytes');
  const copied = await createTransferService().transfer({ sources: [file], destination, operation: 'copy' });
  assert.equal(copied.completed.length, 1, JSON.stringify(copied));
  assert.equal(await fs.readFile(path.join(destination, 'long-path.txt'), 'utf8'), 'long path bytes');
  const nested = path.join(destination, 'move-to');
  await fs.mkdir(nested);
  const folder = path.join(f.source, 'long-path-folder');
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'child.txt'), 'nested bytes');
  const moved = await createTransferService().transfer({ sources: [file, folder], destination: nested, operation: 'move' });
  assert.equal(moved.completed.length, 2, JSON.stringify(moved));
  await missing(file);
  await missing(folder);
  assert.equal(await fs.readFile(path.join(nested, 'long-path.txt'), 'utf8'), 'long path bytes');
  assert.equal(await fs.readFile(path.join(nested, 'long-path-folder', 'child.txt'), 'utf8'), 'nested bytes');
});

test('native network errors and transfer diagnostics retain actionable causes', async () => {
  for (const [win32, code] of [[53, 'ENETUNREACH'], [64, 'ENETUNREACH'], [67, 'ENETUNREACH'],
    [121, 'ETIMEDOUT'], [1231, 'ENETUNREACH'], [1232, 'EHOSTUNREACH'], [32, 'EBUSY'], [5, 'EACCES']]) {
    await assert.rejects(nativeResponse(JSON.stringify({ ok: false, win32, message: 'native cause' })), error => {
      assert.equal(error.code, code);
      const detail = transferError(error);
      assert.equal(detail.code, code);
      assert.equal(detail.win32, win32);
      assert.equal(detail.nativeError, 'native cause');
      return true;
    });
  }
  for (const code of ['ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT', 'ECONNRESET', 'ENODEV', 'EIO']) {
    assert.equal(transferError(Object.assign(new Error('fixture I/O failure'), { code })).code, code);
  }
});

test('uncertain move results preserve both locations and the underlying cause without retry', async () => {
  const f = await fixture();
  const source = path.join(f.source, 'ambiguous.txt');
  await fs.writeFile(source, 'preserved bytes');
  let calls = 0;
  const service = createTransferService({ nativeMove: async (from, to) => {
    calls++;
    await fs.rename(from, to);
    throw Object.assign(new Error('reply lost'), { code: 'ETIMEDOUT', win32: 121 });
  } });
  const result = await service.transfer({ sources: [source], destination: f.destination, operation: 'move' });
  assert.equal(calls, 1);
  assert.equal(result.failed[0].code, 'PARTIAL_MOVE');
  assert.equal(result.failed[0].causeCode, 'ETIMEDOUT');
  assert.equal(result.failed[0].win32, 121);
  assert.equal(await fs.readFile(path.join(f.destination, 'ambiguous.txt'), 'utf8'), 'preserved bytes');
  await missing(source);
});

test('real Windows read lock allows copy, refuses same-volume move, and releases for a later explicit move', async () => {
  const f = await fixture();
  const source = path.join(f.source, 'locked.txt');
  await fs.writeFile(source, 'locked source bytes');
  const service = createTransferService();
  await withReadLock(source, async () => {
    const failed = await service.transfer({ sources: [source], destination: f.destination, operation: 'move' });
    assert.equal(failed.failed[0].code, 'EBUSY', JSON.stringify(failed));
    assert.equal(failed.failed[0].win32, 32);
    assert.equal(await fs.readFile(source, 'utf8'), 'locked source bytes');
    assert.deepEqual(await fs.readdir(f.destination), []);
    const copied = await service.transfer({ sources: [source], destination: f.destination, operation: 'copy' });
    assert.equal(copied.completed.length, 1, JSON.stringify(copied));
    assert.equal(await fs.readFile(path.join(f.destination, 'locked.txt'), 'utf8'), 'locked source bytes');
  });
  const after = path.join(f.directory, 'after-lock');
  await fs.mkdir(after);
  const moved = await service.transfer({ sources: [source], destination: after, operation: 'move' });
  assert.equal(moved.completed.length, 1, JSON.stringify(moved));
  await missing(source);
  assert.equal(await fs.readFile(path.join(after, 'locked.txt'), 'utf8'), 'locked source bytes');
});

test('real Unicode file copy preserves bytes and modification date without changing source', async () => {
  const f = await fixture();
  const filename = path.join(f.source, "한글 client's & $report.txt");
  const bytes = Buffer.from('원본 내용\n'.repeat(300));
  await fs.writeFile(filename, bytes);
  await fs.utimes(filename, new Date('2024-05-06T12:34:56Z'), new Date('2024-05-06T12:34:56Z'));
  const result = await createTransferService().transfer({ sources: [filename], destination: f.destination, operation: 'copy' });
  assert.equal(result.completed.length, 1, JSON.stringify(result));
  const target = path.join(f.destination, path.basename(filename));
  assert.deepEqual(await fs.readFile(target), bytes);
  assert.deepEqual(await fs.readFile(filename), bytes);
  assert.equal((await fs.stat(target)).mtime.toISOString(), '2024-05-06T12:34:56.000Z');
  assert.deepEqual(await fs.readdir(f.destination), [path.basename(filename)]);
});

test('NTFS alternate data streams survive standalone and nested file copies', async () => {
  const f = await fixture();
  const standalone = path.join(f.source, 'download.txt');
  const folder = path.join(f.source, 'stream-folder');
  const nested = path.join(folder, 'nested.txt');
  await fs.mkdir(folder);
  const streams = { 'Zone.Identifier': '[ZoneTransfer]\r\nZoneId=3\r\n', 'custom.metadata': '한글 metadata\n' };
  for (const filename of [standalone, nested]) {
    await fs.writeFile(filename, 'unnamed file contents');
    for (const [name, contents] of Object.entries(streams)) await fs.writeFile(`${filename}:${name}`, contents);
  }
  const result = await createTransferService().transfer({ sources: [standalone, folder], destination: f.destination, operation: 'copy' });
  assert.equal(result.completed.length, 2, JSON.stringify(result));
  for (const [original, target] of [
    [standalone, path.join(f.destination, 'download.txt')],
    [nested, path.join(f.destination, 'stream-folder', 'nested.txt')],
  ]) {
    assert.equal(await fs.readFile(target, 'utf8'), 'unnamed file contents');
    for (const [name, contents] of Object.entries(streams)) {
      assert.equal(await fs.readFile(`${target}:${name}`, 'utf8'), contents);
      assert.equal(await fs.readFile(`${original}:${name}`, 'utf8'), contents);
    }
  }
  assert.deepEqual((await fs.readdir(f.destination)).sort(), ['download.txt', 'stream-folder']);
});

test('real folder copy includes nested and empty folders; real file and folder move remove only originals', async () => {
  const f = await fixture();
  const folder = path.join(f.source, '한글 폴더');
  await fs.mkdir(path.join(folder, 'child'), { recursive: true });
  await fs.mkdir(path.join(folder, 'empty'));
  await fs.writeFile(path.join(folder, 'child', 'a.txt'), 'folder content');
  const service = createTransferService();
  const copied = await service.transfer({ sources: [folder], destination: f.destination, operation: 'copy' });
  assert.equal(copied.completed.length, 1, JSON.stringify(copied));
  assert.equal(await fs.readFile(path.join(f.destination, '한글 폴더', 'child', 'a.txt'), 'utf8'), 'folder content');
  assert.deepEqual(await fs.readdir(path.join(f.destination, '한글 폴더', 'empty')), []);
  const movedTo = path.join(f.directory, 'move-target');
  await fs.mkdir(movedTo);
  const moved = await service.transfer({ sources: [folder], destination: movedTo, operation: 'move' });
  assert.equal(moved.completed.length, 1, JSON.stringify(moved));
  await missing(folder);
  assert.equal(await fs.readFile(path.join(movedTo, '한글 폴더', 'child', 'a.txt'), 'utf8'), 'folder content');
  const file = path.join(f.source, 'move.txt');
  await fs.writeFile(file, 'move bytes');
  assert.equal((await service.transfer({ sources: [file], destination: movedTo, operation: 'move' })).completed.length, 1);
  await missing(file);
  assert.equal(await fs.readFile(path.join(movedTo, 'move.txt'), 'utf8'), 'move bytes');
});

test('file and directory conflicts never overwrite or merge existing data', async () => {
  const f = await fixture();
  const source = path.join(f.source, 'same.txt');
  const target = path.join(f.destination, 'same.txt');
  await fs.writeFile(source, 'source original');
  await fs.writeFile(target, 'destination original');
  for (const operation of ['copy', 'move']) {
    const result = await createTransferService().transfer({ sources: [source], destination: f.destination, operation });
    assert.equal(result.skipped[0].code, 'EEXIST');
    assert.equal(await fs.readFile(source, 'utf8'), 'source original');
    assert.equal(await fs.readFile(target, 'utf8'), 'destination original');
  }
  await fs.mkdir(path.join(f.source, 'same-folder'));
  await fs.mkdir(path.join(f.destination, 'same-folder'));
  await fs.writeFile(path.join(f.source, 'same-folder', 'source.txt'), 'stay');
  await fs.writeFile(path.join(f.destination, 'same-folder', 'destination.txt'), 'keep');
  const result = await createTransferService().transfer({ sources: [path.join(f.source, 'same-folder')], destination: f.destination, operation: 'move' });
  assert.equal(result.skipped[0].code, 'EEXIST');
  assert.deepEqual(await fs.readdir(path.join(f.destination, 'same-folder')), ['destination.txt']);
  assert.deepEqual(await fs.readdir(path.join(f.source, 'same-folder')), ['source.txt']);
});

test('self, descendant, junction source/child/destination are refused before mutation', async () => {
  const f = await fixture();
  const source = path.join(f.source, 'folder');
  await fs.mkdir(path.join(source, 'child'), { recursive: true });
  await fs.writeFile(path.join(source, 'keep.txt'), 'stay');
  const service = createTransferService();
  assert.equal((await service.transfer({ sources: [source], destination: f.source, operation: 'move' })).skipped[0].code, 'SAME_LOCATION');
  assert.equal((await service.transfer({ sources: [source], destination: path.join(source, 'child'), operation: 'copy' })).skipped[0].code, 'DESCENDANT_TARGET');
  const alias = path.join(f.directory, 'alias');
  await fs.symlink(path.join(source, 'child'), alias, 'junction');
  await assert.rejects(service.transfer({ sources: [source], destination: alias, operation: 'move' }), { code: 'LINK_NOT_SUPPORTED' });
  assert.equal((await service.transfer({ sources: [alias], destination: f.destination, operation: 'copy' })).skipped[0].code, 'LINK_NOT_SUPPORTED');
  await fs.symlink(f.destination, path.join(source, 'linked-child'), 'junction');
  assert.equal((await service.transfer({ sources: [source], destination: f.destination, operation: 'move' })).skipped[0].code, 'LINK_NOT_SUPPORTED');
  assert.equal(await fs.readFile(path.join(source, 'keep.txt'), 'utf8'), 'stay');
  assert.deepEqual(await fs.readdir(f.destination), []);
});

test('partial copy and native move errors preserve originals, no incomplete final copy published', async () => {
  const f = await fixture();
  const source = path.join(f.source, 'folder');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'a.txt'), 'a');
  await fs.writeFile(path.join(source, 'b.txt'), 'b');
  let copies = 0;
  const service = createTransferService({ copyFile: async (...args) => {
    if (++copies === 2) throw Object.assign(new Error('simulated disk full'), { code: 'ENOSPC' });
    return copyFileRecord(...args);
  } });
  const result = await service.transfer({ sources: [source], destination: f.destination, operation: 'copy' });
  assert.equal(result.failed[0].code, 'ENOSPC', JSON.stringify(result));
  assert.deepEqual(await fs.readdir(f.destination), []);
  assert.equal(await fs.readFile(path.join(source, 'a.txt'), 'utf8'), 'a');
  assert.equal(await fs.readFile(path.join(source, 'b.txt'), 'utf8'), 'b');
  const failMove = createTransferService({ nativeMove: async () => { throw Object.assign(new Error('locked'), { code: 'EBUSY' }); } });
  assert.equal((await failMove.transfer({ sources: [source], destination: f.destination, operation: 'move' })).failed[0].code, 'EBUSY');
  assert.deepEqual(await fs.readdir(source), ['a.txt', 'b.txt']);
});

test('native no-replace protects destination appearing after preflight, and lock rejects duplicate jobs', async () => {
  const f = await fixture();
  const source = path.join(f.source, 'race.txt');
  await fs.writeFile(source, 'source');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const service = createTransferService({ nativeMove: async (...args) => {
    await gate;
    await fs.writeFile(args[1], 'arrived later', { flag: 'wx' });
    return nativeMove(...args);
  } });
  const pending = service.transfer({ sources: [source], destination: f.destination, operation: 'move' });
  assert.equal(service.pending, pending);
  await assert.rejects(service.transfer({ sources: [source], destination: f.destination, operation: 'move' }), { code: 'TRANSFER_BUSY' });
  release();
  const result = await pending;
  assert.equal(result.skipped[0].code, 'EEXIST', JSON.stringify(result));
  assert.equal(await fs.readFile(source, 'utf8'), 'source');
  assert.equal(await fs.readFile(path.join(f.destination, 'race.txt'), 'utf8'), 'arrived later');
});

test('copy publish conflict keeps the newly arrived destination and removes only staging contents', async () => {
  const f = await fixture();
  const source = path.join(f.source, 'race-copy.txt');
  await fs.writeFile(source, 'source copy');
  const service = createTransferService({ nativeMove: async (...args) => {
    await fs.writeFile(args[1], 'external destination', { flag: 'wx' });
    return nativeMove(...args);
  } });
  const result = await service.transfer({ sources: [source], destination: f.destination, operation: 'copy' });
  assert.equal(result.skipped[0].code, 'EEXIST', JSON.stringify(result));
  assert.equal(await fs.readFile(source, 'utf8'), 'source copy');
  assert.equal(await fs.readFile(path.join(f.destination, 'race-copy.txt'), 'utf8'), 'external destination');
  assert.deepEqual(await fs.readdir(f.destination), ['race-copy.txt']);
});

test('partial native tree move preserves successful destinations and untouched source files with recovery message', async () => {
  const f = await fixture();
  const source = path.join(f.source, 'partial-folder');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'a.txt'), 'success data');
  await fs.writeFile(path.join(source, 'b.txt'), 'remaining data');
  const service = createTransferService({ nativeMove: async (from, to, mode) => {
    if (mode === 'directory') throw Object.assign(new Error('cross volume'), { code: 'EXDEV' });
    assert.equal(mode, 'tree');
    await nativeMove(path.join(from, 'a.txt'), path.join(to, 'a.txt'), 'file');
    throw Object.assign(new Error('remaining file locked'), { code: 'EBUSY' });
  } });
  const result = await service.transfer({ sources: [source], destination: f.destination, operation: 'move' });
  assert.equal(result.failed[0].code, 'PARTIAL_MOVE', JSON.stringify(result));
  assert.ok(result.failed[0].message.includes(source));
  assert.ok(result.failed[0].message.includes(path.join(f.destination, 'partial-folder')));
  assert.equal(result.completed.length, 0);
  assert.equal(await fs.readFile(path.join(f.destination, 'partial-folder', 'a.txt'), 'utf8'), 'success data');
  assert.equal(await fs.readFile(path.join(source, 'b.txt'), 'utf8'), 'remaining data');
  await missing(path.join(source, 'a.txt'));
});

test('cross-volume file and nested folder move preserve bytes, remove originals, and skip conflicts', { skip: !process.env.PANE_TEST_CROSS_VOLUME_DIR }, async () => {
  const f = await fixture();
  const external = path.resolve(process.env.PANE_TEST_CROSS_VOLUME_DIR);
  assert.notEqual(path.parse(external).root.toLowerCase(), path.parse(f.directory).root.toLowerCase());
  await fs.mkdir(external, { recursive: true });
  const destination = await fs.mkdtemp(path.join(external, 'pane-transfer-test-'));
  assert.notEqual((await fs.stat(destination)).dev, (await fs.stat(f.source)).dev, 'fixture must span physical volumes');
  const file = path.join(f.source, 'cross-volume.txt');
  const folder = path.join(f.source, 'cross-volume-folder');
  await fs.writeFile(file, 'cross-volume file');
  await fs.writeFile(`${file}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n');
  await fs.mkdir(path.join(folder, 'nested'), { recursive: true });
  await fs.mkdir(path.join(folder, 'empty'));
  await fs.writeFile(path.join(folder, 'nested', '한글.txt'), 'cross-volume folder');
  await fs.writeFile(`${path.join(folder, 'nested', '한글.txt')}:custom.metadata`, 'nested stream bytes');
  const copyDestination = path.join(destination, 'copies');
  await fs.mkdir(copyDestination);
  const copy = await createTransferService().transfer({ sources: [file, folder], destination: copyDestination, operation: 'copy' });
  assert.equal(copy.completed.length, 2, JSON.stringify(copy));
  assert.equal(await fs.readFile(path.join(copyDestination, 'cross-volume.txt'), 'utf8'), 'cross-volume file');
  assert.equal(await fs.readFile(path.join(copyDestination, 'cross-volume-folder', 'nested', '한글.txt'), 'utf8'), 'cross-volume folder');
  assert.deepEqual(await fs.readdir(path.join(copyDestination, 'cross-volume-folder', 'empty')), []);
  const result = await createTransferService().transfer({ sources: [file, folder], destination, operation: 'move' });
  assert.equal(result.completed.length, 2, JSON.stringify(result));
  await missing(file);
  await missing(folder);
  assert.equal(await fs.readFile(path.join(destination, 'cross-volume.txt'), 'utf8'), 'cross-volume file');
  assert.equal(await fs.readFile(`${path.join(destination, 'cross-volume.txt')}:Zone.Identifier`, 'utf8'), '[ZoneTransfer]\r\nZoneId=3\r\n');
  assert.equal(await fs.readFile(`${path.join(destination, 'cross-volume-folder', 'nested', '한글.txt')}:custom.metadata`, 'utf8'), 'nested stream bytes');
  assert.equal(await fs.readFile(path.join(destination, 'cross-volume-folder', 'nested', '한글.txt'), 'utf8'), 'cross-volume folder');
  assert.deepEqual(await fs.readdir(path.join(destination, 'cross-volume-folder', 'empty')), []);
  await fs.writeFile(file, 'new source stays');
  const conflict = await createTransferService().transfer({ sources: [file], destination, operation: 'move' });
  assert.equal(conflict.skipped[0].code, 'EEXIST');
  assert.equal(await fs.readFile(file, 'utf8'), 'new source stays');
  assert.equal(await fs.readFile(path.join(destination, 'cross-volume.txt'), 'utf8'), 'cross-volume file');
});

test('real cross-volume move of a locked file preserves the source and reports the native lock', { skip: !process.env.PANE_TEST_CROSS_VOLUME_DIR }, async () => {
  const f = await fixture();
  const external = path.resolve(process.env.PANE_TEST_CROSS_VOLUME_DIR);
  await fs.mkdir(external, { recursive: true });
  const destination = await fs.mkdtemp(path.join(external, 'pane-locked-test-'));
  assert.notEqual((await fs.stat(destination)).dev, (await fs.stat(f.source)).dev);
  const source = path.join(f.source, 'locked-cross.txt');
  await fs.writeFile(source, 'both copies must survive');
  await withReadLock(source, async () => {
    const result = await createTransferService().transfer({ sources: [source], destination, operation: 'move' });
    assert.equal(result.failed[0].code, 'EBUSY', JSON.stringify(result));
    assert.equal(result.failed[0].win32, 32);
    assert.equal(result.completed.length, 0);
    assert.equal(await fs.readFile(source, 'utf8'), 'both copies must survive');
    await missing(path.join(destination, 'locked-cross.txt'));
  });
});

test('real cross-volume tree move with a locked child retains partial progress without retrying', { skip: !process.env.PANE_TEST_CROSS_VOLUME_DIR }, async () => {
  const f = await fixture();
  const external = path.resolve(process.env.PANE_TEST_CROSS_VOLUME_DIR);
  await fs.mkdir(external, { recursive: true });
  const destination = await fs.mkdtemp(path.join(external, 'pane-partial-test-'));
  assert.notEqual((await fs.stat(destination)).dev, (await fs.stat(f.source)).dev);
  const folder = path.join(f.source, 'partial-tree');
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'available.txt'), 'movable bytes');
  const locked = path.join(folder, 'locked.txt');
  await fs.writeFile(locked, 'locked bytes');
  let calls = 0;
  const service = createTransferService({ nativeMove: (...args) => { calls++; return nativeMove(...args); } });
  await withReadLock(locked, async () => {
    const result = await service.transfer({ sources: [folder], destination, operation: 'move' });
    assert.equal(result.failed[0].code, 'PARTIAL_MOVE', JSON.stringify(result));
    assert.equal(result.completed.length, 0);
    assert.equal(calls, 1);
    assert.equal(await fs.readFile(locked, 'utf8'), 'locked bytes');
    assert.equal(await fs.readFile(path.join(destination, 'partial-tree', 'available.txt'), 'utf8'), 'movable bytes');
    await missing(path.join(folder, 'available.txt'));
  });
});

test('cross-volume tree move never overwrites a child created after destination reservation', { skip: !process.env.PANE_TEST_CROSS_VOLUME_DIR }, async () => {
  const f = await fixture();
  const external = path.resolve(process.env.PANE_TEST_CROSS_VOLUME_DIR);
  await fs.mkdir(external, { recursive: true });
  const destination = await fs.mkdtemp(path.join(external, 'pane-conflict-test-'));
  assert.notEqual((await fs.stat(destination)).dev, (await fs.stat(f.source)).dev);
  const folder = path.join(f.source, 'race-tree');
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'conflict.txt'), 'source original');
  await fs.writeFile(path.join(folder, 'movable.txt'), 'move safely');
  let calls = 0;
  const service = createTransferService({ nativeMove: async (from, to, mode) => {
    calls++;
    assert.equal(mode, 'tree');
    await fs.writeFile(path.join(to, 'conflict.txt'), 'arrived later', { flag: 'wx' });
    return nativeMove(from, to, mode);
  } });
  const result = await service.transfer({ sources: [folder], destination, operation: 'move' });
  assert.equal(result.failed[0].code, 'PARTIAL_MOVE', JSON.stringify(result));
  assert.equal(calls, 1);
  assert.equal(await fs.readFile(path.join(folder, 'conflict.txt'), 'utf8'), 'source original');
  assert.equal(await fs.readFile(path.join(destination, 'race-tree', 'conflict.txt'), 'utf8'), 'arrived later');
  assert.equal(await fs.readFile(path.join(destination, 'race-tree', 'movable.txt'), 'utf8'), 'move safely');
});
