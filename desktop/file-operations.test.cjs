'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createTransferService, validateTransfer, copyFileRecord, nativeMove } = require('./file-operations.cjs');
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

test('validation rejects protocols, devices, relative paths, aliases and malformed requests', () => {
  for (const source of [null, 44, 'C:relative', 'https://x', '\\\\.\\C:', 'C:\\work\\name.', 'C:\\work\\NUL.txt']) {
    assert.throws(() => validateTransfer({ sources: [source], destination: 'C:\\output', operation: 'copy' }));
  }
  assert.throws(() => validateTransfer({ sources: [], destination: 'C:\\output', operation: 'move' }));
  assert.throws(() => validateTransfer({ sources: ['C:\\work'], destination: 'C:\\output', operation: 'delete' }));
  assert.equal(validateTransfer({ sources: ['C:\\work', 'c:\\WORK'], destination: 'D:/output', operation: 'copy' }).sources.length, 1);
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
  const file = path.join(f.source, 'cross-volume.txt');
  const folder = path.join(f.source, 'cross-volume-folder');
  await fs.writeFile(file, 'cross-volume file');
  await fs.mkdir(path.join(folder, 'nested'), { recursive: true });
  await fs.writeFile(path.join(folder, 'nested', '한글.txt'), 'cross-volume folder');
  const result = await createTransferService().transfer({ sources: [file, folder], destination, operation: 'move' });
  assert.equal(result.completed.length, 2, JSON.stringify(result));
  await missing(file);
  await missing(folder);
  assert.equal(await fs.readFile(path.join(destination, 'cross-volume.txt'), 'utf8'), 'cross-volume file');
  assert.equal(await fs.readFile(path.join(destination, 'cross-volume-folder', 'nested', '한글.txt'), 'utf8'), 'cross-volume folder');
  await fs.writeFile(file, 'new source stays');
  const conflict = await createTransferService().transfer({ sources: [file], destination, operation: 'move' });
  assert.equal(conflict.skipped[0].code, 'EEXIST');
  assert.equal(await fs.readFile(file, 'utf8'), 'new source stays');
  assert.equal(await fs.readFile(path.join(destination, 'cross-volume.txt'), 'utf8'), 'cross-volume file');
});
