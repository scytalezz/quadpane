'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync, spawnSync } = require('node:child_process');
const { after, test } = require('node:test');
const { normalizePath, locationDetails, listDirectory, closeDirectoryReader, getFavorites, errorResult } = require('./filesystem.cjs');
const { createSessionStore, validateSession, MAX_SESSION_BYTES } = require('./session-store.cjs');

after(() => closeDirectoryReader());

const fixtureParent = path.resolve(__dirname, '..', '.checks', 'native-unit-fixtures');
async function fixture(t) {
  await fs.mkdir(fixtureParent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(fixtureParent, 'run-'));
  t.after(async () => {
    const relative = path.relative(fixtureParent, path.resolve(directory));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function filesystemWithReader(reader, { stat = () => { throw new Error('Unexpected fs.stat'); } } = {}) {
  const module = { exports: {} };
  vm.runInNewContext(await fs.readFile(path.join(__dirname, 'filesystem.cjs'), 'utf8'), {
    module, process, __dirname, setTimeout, clearTimeout,
    require: name => {
      if (name === './directory-service.cjs') return { createDirectoryService: () => reader };
      if (name === 'node:fs/promises') return { ...fs, stat };
      return require(name);
    },
  });
  return module.exports;
}

function readNativeAttributes(input, extraArgs = []) {
  return spawnSync(path.join(__dirname, 'native', 'bin', 'Quadpane.Shell.exe'), ['--read-hidden-attributes', ...extraArgs], {
    windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', input,
  });
}

function setHidden(paths, hidden) {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  execFileSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$request = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
foreach ($item in $request.paths) {
  $attributes = [IO.File]::GetAttributes($item)
  if ($request.hidden) { $attributes = $attributes -bor [IO.FileAttributes]::Hidden }
  else { $attributes = $attributes -band (-bnot [IO.FileAttributes]::Hidden) }
  [IO.File]::SetAttributes($item, $attributes)
}
`], { windowsHide: true, timeout: 15000, encoding: 'utf8', input: JSON.stringify({ paths: paths.map(filename => path.win32.toNamespacedPath(filename)), hidden }) });
}

function sessionWith(directory) {
  const workspace = () => ({ layout: 4, active: 2, panes: Array.from({ length: 4 }, (_, index) => ({
    path: path.win32.join(directory, `panel-${index}`), sort: index === 2 ? 'modified' : 'name', direction: index === 2 ? -1 : 1,
  })) });
  return { version: 1, workspaceId: 'documents', workspaces: { design: workspace(), documents: workspace() } };
}

test('normalizes absolute Windows paths and builds root-aware breadcrumbs', () => {
  assert.equal(normalizePath(' "c:/Users/테스트/../문서/" '), 'C:\\Users\\문서');
  assert.equal(normalizePath('D:\\'), 'D:\\');
  assert.equal(normalizePath('C:\\..\\Windows'), 'C:\\Windows');
  const driveRoot = locationDetails('D:\\');
  assert.equal(driveRoot.parent, null);
  assert.deepEqual(driveRoot.breadcrumbs, [{ name: 'D:', path: 'D:\\' }]);
  const sharedRoot = normalizePath('\\\\server.example.com\\공유$');
  assert.equal(sharedRoot, '\\\\server.example.com\\공유$\\');
  const shared = locationDetails(`${sharedRoot}작업\\자료`);
  assert.equal(shared.parent, `${sharedRoot}작업`);
  assert.deepEqual(shared.breadcrumbs, [
    { name: '\\\\server.example.com\\공유$', path: sharedRoot },
    { name: '작업', path: `${sharedRoot}작업` },
    { name: '자료', path: `${sharedRoot}작업\\자료` },
  ]);
  assert.equal(locationDetails(sharedRoot).parent, null);
});

test('rejects relative, protocol, stream, device namespace and malformed inputs', () => {
  for (const value of [null, {}, 3, '', '.', '..\\file', 'C:folder', 'C:', '\\Users',
    'file:///C:/Users', 'https://example.com', '\\\\server', '\\\\server\\..',
    '\\\\?\\C:\\Users', '\\\\.\\C:', '\\??\\C:\\Users', 'C:\\a\u0000b',
    'C:\\file:stream', 'C:\\foo|bar', 'C:\\foo?bar', `C:\\${'x'.repeat(32768)}`]) {
    assert.throws(() => normalizePath(value), { code: 'INVALID_PATH' });
  }
});

test('lists real fixture folders, file size, exact mtime, unicode and empty directories', async t => {
  const directory = await fixture(t);
  await fs.mkdir(path.join(directory, '비어 있는 폴더'));
  await fs.mkdir(path.join(directory, 'z-folder'));
  const filename = path.join(directory, '한글 & spaced.txt');
  const content = Buffer.from('안녕하세요\nactual bytes');
  await fs.writeFile(filename, content);
  const modified = new Date('2025-02-03T04:05:06.000Z');
  await fs.utimes(filename, modified, modified);
  const result = await listDirectory(directory);
  assert.equal(result.path, normalizePath(directory));
  assert.equal(result.entries.length, 3);
  const file = result.entries.find(entry => entry.name === '한글 & spaced.txt');
  assert.equal(file.type, 'file');
  assert.equal(file.size, content.length);
  assert.equal(file.modified, modified.toISOString());
  assert.equal(file.hidden, false);
  const folder = result.entries.find(entry => entry.name === '비어 있는 폴더');
  assert.equal(folder.type, 'folder');
  assert.equal(folder.size, null);
  assert.equal(folder.hidden, false);
  assert.equal(typeof folder.modified, 'string');
  assert.deepEqual((await listDirectory(folder.path)).entries, []);
  await assert.rejects(() => listDirectory(filename), { code: 'ENOTDIR' });
  await assert.rejects(() => listDirectory(path.join(directory, 'missing')), { code: 'ENOENT' });
});

test('does not truncate large folders and navigates a directory junction', async t => {
  const directory = await fixture(t);
  const realFolder = path.join(directory, 'real-folder');
  await fs.mkdir(realFolder);
  await Promise.all(Array.from({ length: 321 }, (_, index) => fs.writeFile(path.join(realFolder, `entry-${index}.txt`), `${index}`)));
  const link = path.join(directory, 'linked-folder');
  await fs.symlink(realFolder, link, 'junction');
  const listing = await listDirectory(directory);
  const junction = listing.entries.find(entry => entry.name === 'linked-folder');
  assert.equal(junction.type, 'folder');
  assert.equal(junction.isSymbolicLink, true);
  const linkedListing = await listDirectory(link);
  assert.equal(linkedListing.entries.length, 321);
  assert.ok(linkedListing.entries.every(entry => entry.hidden === false));
  assert.equal(new Set(linkedListing.entries.map(entry => entry.name)).size, 321);
  for (const entry of linkedListing.entries) {
    assert.equal(entry.path, path.join(link, entry.name));
    assert.equal(entry.type, 'file');
  }
});

test('real directory refresh observes creates, renames, metadata updates and deletes without a completed-result cache', async t => {
  const directory = await fixture(t);
  const original = path.join(directory, 'created.txt');
  const renamed = path.join(directory, '이름 바꿈 😀.txt');
  assert.deepEqual((await listDirectory(directory)).entries, []);

  await fs.writeFile(original, 'first');
  const created = await listDirectory(directory);
  assert.deepEqual(created.entries.map(entry => entry.name), ['created.txt']);
  assert.equal(created.entries[0].size, 5);

  await fs.rename(original, renamed);
  const renamedListing = await listDirectory(directory);
  assert.deepEqual(renamedListing.entries.map(entry => entry.name), [path.basename(renamed)]);
  assert.equal(renamedListing.entries[0].path, renamed);

  const content = Buffer.from('새로운 내용 with a different size');
  const modified = new Date('2025-07-08T09:10:11.000Z');
  await fs.writeFile(renamed, content);
  await fs.utimes(renamed, modified, modified);
  const updated = await listDirectory(directory);
  assert.equal(updated.entries[0].size, content.length);
  assert.equal(updated.entries[0].modified, modified.toISOString());

  await fs.unlink(renamed);
  assert.deepEqual((await listDirectory(directory)).entries, []);
});

test('accurate real directory refresh observes writes through another hardlink', { skip: process.platform !== 'win32' }, async t => {
  const directory = await fixture(t);
  const listedDirectory = path.join(directory, 'listed');
  const source = path.join(directory, 'original.txt');
  const alias = path.join(listedDirectory, '하드링크 😀.txt');
  await fs.mkdir(listedDirectory);
  await fs.writeFile(source, 'initial');
  await fs.link(source, alias);
  assert.deepEqual((await listDirectory(listedDirectory)).entries.map(entry => entry.name), [path.basename(alias)]);

  for (const [content, modified] of [
    [Buffer.from('changed through the other name'), new Date('2025-07-08T09:10:11.000Z')],
    [Buffer.from('다시 변경한 내용 with another length'), new Date('2025-08-09T10:11:12.000Z')],
  ]) {
    await fs.writeFile(source, content);
    await fs.utimes(source, modified, modified);
    // NTFS enumeration can retain stale metadata for the alias. Only accurate
    // refresh promises current metadata; do not stat/open the alias in the test.
    await listDirectory(listedDirectory);
    const result = await listDirectory(listedDirectory, { accurate: true });
    assert.equal(result.entries.length, 1);
    const entry = result.entries[0];
    assert.equal(entry.path, alias);
    assert.equal(entry.type, 'file');
    assert.equal(entry.size, content.length);
    assert.equal(entry.modified, modified.toISOString());
    assert.equal(entry.isSymbolicLink, undefined, 'hardlinks are ordinary file entries');
    assert.equal(result.skipped, undefined);
  }
});

test('real broken junction is skipped while neighboring files remain readable', { skip: process.platform !== 'win32' }, async t => {
  const directory = await fixture(t);
  const target = path.join(directory, 'target');
  const junction = path.join(directory, 'junction');
  await fs.mkdir(target);
  await fs.symlink(target, junction, 'junction');
  await fs.writeFile(path.join(directory, 'kept.txt'), 'kept');
  const before = await listDirectory(directory);
  assert.equal(before.entries.find(entry => entry.name === 'junction').isSymbolicLink, true);

  await fs.rmdir(target);
  assert.equal((await fs.lstat(junction)).isSymbolicLink(), true, 'the broken junction still exists');
  for (const accurate of [false, true]) {
    const result = await listDirectory(directory, { accurate });
    assert.equal(result.skipped, 1);
    assert.deepEqual(result.entries.map(entry => entry.name), ['kept.txt']);
    assert.equal(result.entries[0].size, 4);
  }
});

test('actual Windows Hidden attributes cover files, folders, Unicode and literal special characters independently of dot prefixes', { skip: process.platform !== 'win32' }, async t => {
  const directory = await fixture(t);
  const visibleNames = ['plain.txt', '.dot-visible', '일반 [폴더]'];
  const hiddenNames = ["숨김 [1] & ' $(throw 42) `.txt", '.dot-hidden', '숨김 폴더'];
  for (const name of [...visibleNames, ...hiddenNames]) {
    if (name.includes('폴더')) await fs.mkdir(path.join(directory, name));
    else await fs.writeFile(path.join(directory, name), 'literal filename');
  }
  setHidden([...visibleNames, ...hiddenNames].map(name => path.join(directory, name)), false);
  setHidden(hiddenNames.map(name => path.join(directory, name)), true);
  const result = await listDirectory(directory);
  assert.equal(result.entries.length, 6, 'the backend returns hidden entries for caller-side filtering');
  for (const entry of result.entries) {
    assert.equal(entry.hidden, hiddenNames.includes(entry.name), entry.name);
    assert.equal(entry.path, path.join(directory, entry.name));
    assert.equal(entry.type, entry.name.includes('폴더') ? 'folder' : 'file');
  }
  setHidden([path.join(directory, 'plain.txt')], true);
  setHidden(hiddenNames.map(name => path.join(directory, name)), false);
  const refreshed = await listDirectory(directory);
  assert.deepEqual(refreshed.entries.filter(entry => entry.hidden).map(entry => entry.name), ['plain.txt']);
});

test('single-entry metadata supports actual Windows paths longer than MAX_PATH', { skip: process.platform !== 'win32' }, async t => {
  const directory = path.join(await fixture(t), 'a'.repeat(140), '한'.repeat(140));
  await fs.mkdir(directory, { recursive: true });
  const filename = path.join(directory, 'long-hidden.txt');
  assert.ok(filename.length > 260);
  await fs.writeFile(filename, 'hidden');
  setHidden([filename], true);
  const { entries } = await listDirectory(directory);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].hidden, true);
  assert.equal(entries[0].path, filename);
});

test('directory reader joins raw metadata to normalized paths without stat calls for ordinary entries', async () => {
  const directory = 'C:\\fixture\\자료';
  const raw = [
    { name: '한글 [1] 😀.txt', type: 'file', size: 123, modified: '2025-02-03T04:05:06.000Z', hidden: true },
    { name: '.dot-visible', type: 'file', size: 0, modified: null, hidden: false },
    { name: '빈 폴더', type: 'folder', size: null, modified: '2025-03-04T05:06:07.000Z', hidden: false },
  ];
  const calls = [];
  let stats = 0;
  const injected = await filesystemWithReader({ list: async (directory, options) => { calls.push({ directory, ...options }); return raw; } }, {
    stat: () => { stats++; throw new Error('Ordinary entries must use reader metadata'); },
  });
  const result = await injected.listDirectory(' "c:/fixture/資料/../자료/" ');
  assert.deepEqual(calls, [{ directory, accurate: false }]);
  assert.equal(stats, 0, 'neither the directory nor ordinary entries need fs.stat');
  assert.deepEqual(structuredClone(result), {
    ...locationDetails(directory),
    entries: raw.map(entry => ({ ...entry, path: path.win32.join(directory, entry.name) })),
  });
});

test('directory reader coalesces concurrent requests with the same exact normalized path and accuracy mode', async () => {
  for (const accurate of [false, true]) {
    const response = Promise.withResolvers();
    const calls = [];
    const injected = await filesystemWithReader({ list: (directory, options) => {
      calls.push({ directory, ...options });
      return response.promise;
    } });
    const requests = ['C:\\fixture\\자료', 'c:/fixture/자료/', ' "C:\\fixture\\child\\..\\자료" ']
      .map(directory => injected.listDirectory(directory, { accurate }));
    await Promise.resolve();
    assert.deepEqual(calls, [{ directory: 'C:\\fixture\\자료', accurate }]);
    response.resolve([{ name: 'shared.txt', type: 'file', size: 3, modified: null, hidden: true }]);
    const results = await Promise.all(requests);
    for (const result of results) {
      assert.equal(result.path, 'C:\\fixture\\자료');
      assert.equal(result.entries[0].path, 'C:\\fixture\\자료\\shared.txt');
      assert.equal(result.entries[0].hidden, true);
      assert.deepEqual(structuredClone(result), structuredClone(results[0]));
    }
    assert.equal(calls.length, 1);
  }
});

test('directory reader keeps accuracy modes, case-distinct paths and other directories in separate in-flight queries', async () => {
  const responses = [];
  const calls = [];
  const injected = await filesystemWithReader({ list: (directory, options) => {
    calls.push({ directory, ...options });
    const response = Promise.withResolvers();
    responses.push(response);
    return response.promise;
  } });
  const queries = [false, true].flatMap(accurate => ['C:\\fixture\\Case', 'C:\\fixture\\case', 'D:\\fixture\\Case']
    .map(directory => ({ directory, accurate })));
  const requests = queries.map(({ directory, accurate }) => injected.listDirectory(directory, { accurate }));
  await Promise.resolve();
  assert.deepEqual(calls, queries);
  // Resolve in reverse order to catch a response being shared across modes.
  responses.toReversed().forEach((response, reverseIndex) => {
    const index = responses.length - 1 - reverseIndex;
    response.resolve([{ name: `entry-${index}.txt`, type: 'file', size: index, modified: null, hidden: false }]);
  });
  const results = await Promise.all(requests);
  results.forEach((result, index) => {
    assert.equal(result.path, queries[index].directory);
    assert.equal(result.entries[0].path, path.win32.join(queries[index].directory, `entry-${index}.txt`));
  });
});

test('directory reader uses fast mode unless accuracy is explicitly true', async () => {
  const calls = [];
  const injected = await filesystemWithReader({ list: async (directory, options) => { calls.push({ directory, ...options }); return []; } });
  for (const options of [undefined, {}, { accurate: false }, { accurate: 'true' }, { accurate: 1 }, { accurate: true }]) {
    await injected.listDirectory('C:\\fixture', options);
  }
  assert.deepEqual(calls.map(call => call.accurate), [false, false, false, false, false, true]);
  assert.ok(calls.every(call => call.directory === 'C:\\fixture'));
});

test('directory reader queries again after each completed listing in both modes, including empty results', async () => {
  const snapshots = [
    [],
    [{ name: 'created.txt', type: 'file', size: 3, modified: null, hidden: false }],
    [{ name: 'renamed.txt', type: 'file', size: 9, modified: '2025-02-03T04:05:06.000Z', hidden: true }],
    [],
  ];
  for (const accurate of [false, true]) {
    let queries = 0;
    const injected = await filesystemWithReader({ list: async () => snapshots[queries++] });
    for (const snapshot of snapshots) {
      const result = await injected.listDirectory('C:\\fixture', { accurate });
      assert.deepEqual(structuredClone(result.entries), snapshot.map(entry => ({ ...entry, path: path.win32.join('C:\\fixture', entry.name) })));
      assert.equal(result.skipped, undefined);
    }
    assert.equal(queries, snapshots.length);
  }
});

test('directory reader failures and native timeouts reject coalesced callers and permit an immediate retry in both modes', async () => {
  for (const accurate of [false, true]) {
    for (const code of ['DIRECTORY_READ_FAILED', 'ETIMEDOUT']) {
      const first = Promise.withResolvers();
      const failure = Object.assign(new Error('private metadata failure'), { code });
      let queries = 0;
      const injected = await filesystemWithReader({ list: () => ++queries === 1 ? first.promise : Promise.resolve([]) });
      const requests = [injected.listDirectory('C:\\fixture', { accurate }), injected.listDirectory('c:/fixture/', { accurate })];
      const rejections = requests.map(request => assert.rejects(request, error => error === failure));
      await Promise.resolve();
      assert.equal(queries, 1);
      first.reject(failure);
      await Promise.all(rejections);
      assert.equal((await injected.listDirectory('C:\\fixture', { accurate })).entries.length, 0);
      assert.equal(queries, 2);
    }
  }
});

test('directory reader uses native link metadata and skips unavailable entries without any Node stat calls', async () => {
  const directory = 'C:\\fixture';
  const modified = '2025-06-07T08:09:10.000Z';
  const raw = [
    { name: 'ordinary.txt', type: 'file', size: 4, modified: null, hidden: false },
    { name: 'linked-file', type: 'file', size: 42, modified, hidden: true, isSymbolicLink: true },
    { name: 'broken', type: 'folder', size: null, modified: null, hidden: true, isSymbolicLink: true, unavailable: true },
    { name: 'linked-folder', type: 'folder', size: null, modified, hidden: false, isSymbolicLink: true },
    { name: 'unreadable.txt', type: 'file', size: 0, modified: null, hidden: false, unavailable: true },
    { name: 'ordinary-folder', type: 'folder', size: null, modified: null, hidden: true },
  ];
  const stats = [];
  const injected = await filesystemWithReader({ list: async () => raw }, { stat: filename => {
    stats.push(filename);
    throw new Error('Even link metadata must stay within the native reader timeout');
  } });
  for (const accurate of [false, true]) {
    const result = await injected.listDirectory(directory, { accurate });
    assert.deepEqual(stats, [], 'no directory, ordinary entry, link or unavailable entry may trigger fs.stat');
    assert.equal(result.skipped, 2);
    const expected = [raw[0], raw[1], raw[3], raw[5]];
    assert.deepEqual(structuredClone(result.entries), expected.map(entry => ({ ...entry, path: path.win32.join(directory, entry.name) })));
  }
});

test('directory reader close rejects all coalesced callers awaiting native queries in both modes', async () => {
  const pending = [];
  const failure = Object.assign(new Error('Reader closed'), { code: 'DIRECTORY_READ_FAILED' });
  let queries = 0, closes = 0, closed = false;
  const injected = await filesystemWithReader({
    list: () => {
      queries++;
      if (closed) return Promise.reject(failure);
      const response = Promise.withResolvers();
      pending.push(response);
      return response.promise;
    },
    close: () => {
      closes++;
      closed = true;
      for (const response of pending) response.reject(failure);
    },
  });
  const requests = [false, true].flatMap(accurate => ['C:\\fixture', 'c:/fixture/']
    .map(directory => injected.listDirectory(directory, { accurate })));
  const rejections = requests.map(request => assert.rejects(request, error => error === failure));
  await Promise.resolve();
  assert.equal(queries, 2);
  injected.closeDirectoryReader();
  await Promise.all(rejections);
  assert.equal(closes, 1);
  for (const accurate of [false, true]) {
    await assert.rejects(injected.listDirectory('C:\\fixture', { accurate }), error => error === failure);
  }
  assert.equal(queries, 4, 'closed queries must also be removed from the in-flight map');
});

test('directory reader propagates metadata errors instead of returning partial or visible-only listings', async () => {
  for (const code of ['DIRECTORY_READ_FAILED', 'METADATA_READ_FAILED', 'ENOENT', 'EACCES', 'ETIMEDOUT']) {
    const failure = Object.assign(new Error('C:\\private\\metadata failure'), { code });
    const injected = await filesystemWithReader({ list: async () => { throw failure; } });
    await assert.rejects(injected.listDirectory('C:\\fixture'), error => error === failure);
  }
});

test('directory reader rejects invalid paths before querying and closes the shared service', async () => {
  let queries = 0, closes = 0;
  const injected = await filesystemWithReader({
    list: async () => { queries++; return []; },
    close: () => { closes++; },
  });
  for (const input of ['relative', 'C:relative', 'file:///C:/fixture']) {
    await assert.rejects(injected.listDirectory(input), { code: 'INVALID_PATH' });
  }
  assert.equal(queries, 0);
  await injected.listDirectory('C:\\fixture');
  await injected.listDirectory('D:\\fixture');
  assert.equal(queries, 2);
  injected.closeDirectoryReader();
  assert.equal(closes, 1);
});

test('native attribute mode exits with ordered UTF-8 results and handles batches beyond the default JSON limit', { skip: process.platform !== 'win32' }, async t => {
  const directory = await fixture(t);
  const hidden = path.join(directory, "숨김 [1] & ' $(throw 42) ` 😀.txt");
  const visible = path.join(directory, '일반 폴더');
  await fs.writeFile(hidden, 'hidden');
  await fs.mkdir(visible);
  setHidden([hidden], true);
  setHidden([visible], false);
  const paths = [hidden, visible, path.join(directory, 'missing')].map(filename => path.win32.toNamespacedPath(filename));
  for (const [input, expected] of [
    [[], []],
    [[paths[0]], [true]],
    [[...paths, paths[1] + '\0suffix', '', paths[0]], [true, false, null, null, null, true]],
  ]) {
    const result = readNativeAttributes(JSON.stringify(input));
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.deepEqual(JSON.parse(result.stdout), expected);
    assert.equal(result.stderr, '');
  }
  const count = Math.max(20000, Math.ceil(2097152 / (JSON.stringify(paths).length - 1)) * paths.length);
  const input = JSON.stringify(Array.from({ length: count }, (_, index) => paths[index % paths.length]));
  assert.ok(input.length > 2097152, 'exercise JavaScriptSerializer default character limit');
  const result = readNativeAttributes(input);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), Array.from({ length: count }, (_, index) => [true, false, null][index % paths.length]));
});

test('native attribute mode rejects malformed input and invalid UTF-8 with nonzero exit and no response', { skip: process.platform !== 'win32' }, () => {
  for (const input of ['', 'not JSON', 'null', '{}', 'false', '"path"', '[', '["path"', '[] trailing', '[null]', '[1]', '[true]', '[{}]', '[[]]', '["path",false]',
    Buffer.from([0x5b, 0x22, 0xff, 0x22, 0x5d])]) {
    const result = readNativeAttributes(input);
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0, String(input));
    assert.equal(result.signal, null);
    assert.equal(result.stdout, '', String(input));
  }
  const extraArgument = readNativeAttributes('[]', ['unexpected']);
  assert.equal(extraArgument.error, undefined);
  assert.notEqual(extraArgument.status, 0);
  assert.equal(extraArgument.stdout, '');
});

test('favorites use provided OS known-folder locations and error messages hide raw failures', () => {
  const favorites = getFavorites(name => {
    if (name === 'desktop') throw new Error('Unavailable known folder');
    return `D:\\redirected\\${name}`;
  });
  assert.deepEqual(favorites.map(favorite => favorite.id), ['home', 'downloads', 'documents', 'pictures']);
  assert.equal(favorites[1].path, 'D:\\redirected\\downloads');
  assert.equal(favorites[3].icon, 'image');
  for (const code of ['ENOENT', 'EACCES', 'ENOTDIR', 'EIO', 'ETIMEDOUT', 'METADATA_READ_FAILED', 'DIRECTORY_READ_FAILED']) {
    const result = errorResult({ code, message: 'C:\\private\\sensitive raw failure' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
    assert.ok(!result.error.message.includes('private'));
  }
  assert.equal(errorResult({ code: '__proto__' }).error.code, 'READ_FAILED');
});

test('session persists both workspaces and unavailable paths across store recreation', async t => {
  const directory = await fixture(t);
  const store = createSessionStore(directory);
  assert.deepEqual(store.load(), { session: null });
  const first = sessionWith('Z:\\disconnected\\작업');
  store.save(first);
  assert.deepEqual(createSessionStore(directory).load(), { session: first });
  const second = structuredClone(first);
  second.workspaceId = 'design';
  second.workspaces.design.layout = 2;
  second.workspaces.design.active = 1;
  second.workspaces.design.panes[1] = { path: '\\\\files.example.com\\공유\\이전 폴더', sort: 'size', direction: -1 };
  store.save(second);
  assert.deepEqual(createSessionStore(directory).load(), { session: second });
  assert.deepEqual(await fs.readdir(directory), ['session.json']);
});

test('long valid Unicode paths larger than 512 KiB persist and reload unchanged', async t => {
  const directory = await fixture(t);
  const longRoot = `C:\\${Array.from({ length: 135 }, () => '한'.repeat(239)).join('\\')}`;
  const session = sessionWith(longRoot);
  assert.ok(session.workspaces.design.panes[0].path.length < 32767);
  const store = createSessionStore(directory);
  store.save(session);
  const fileBytes = (await fs.stat(path.join(directory, 'session.json'))).size;
  assert.ok(fileBytes > 512 * 1024);
  assert.ok(fileBytes <= MAX_SESSION_BYTES);
  assert.deepEqual(createSessionStore(directory).load(), { session });
});

test('two-panel sessions normalize hidden active panels and retain every saved path', async t => {
  const directory = await fixture(t);
  const store = createSessionStore(directory);
  for (const active of [0, 1, 2, 3]) {
    const session = sessionWith('D:\\fixture');
    session.workspaces.design.layout = 2;
    session.workspaces.design.active = active;
    session.workspaces.documents.layout = 1;
    session.workspaces.documents.active = active;
    const expected = structuredClone(session);
    expected.workspaces.design.active = active > 1 ? 0 : active;
    assert.deepEqual(validateSession(session), expected);
    store.save(session);
    assert.deepEqual(createSessionStore(directory).load(), { session: expected });
  }
});

test('session schema strips unknown fields and rejects invalid paths, versions, sparse panes and settings', () => {
  const input = sessionWith('C:\\fixture');
  input.command = 'must not persist';
  input.workspaces.design.name = 'must not persist';
  input.workspaces.design.panes[0].content = 'must not persist';
  const validated = validateSession(input);
  assert.equal(validated.command, undefined);
  assert.equal(validated.workspaces.design.name, undefined);
  assert.equal(validated.workspaces.design.panes[0].content, undefined);
  for (const change of [
    value => { value.version = 2; },
    value => { value.workspaceId = 'unknown'; },
    value => { value.workspaces.design.layout = 3; },
    value => { value.workspaces.design.active = 4; },
    value => { value.workspaces.design.panes[0].direction = 0; },
    value => { value.workspaces.design.panes[0].sort = 'arbitrary'; },
    value => { value.workspaces.design.panes[0].path = 'relative'; },
    value => { value.workspaces.design.panes.pop(); },
    value => { delete value.workspaces.design.panes[1]; },
  ]) {
    const changed = structuredClone(input);
    change(changed);
    assert.throws(() => validateSession(changed), { code: 'INVALID_SESSION' });
  }
});

test('corrupt or unsupported session reports warning while retaining the original file', async t => {
  const directory = await fixture(t);
  const filename = path.join(directory, 'session.json');
  const store = createSessionStore(directory);
  for (const text of ['{broken json', JSON.stringify({ ...sessionWith('C:\\fixture'), version: 99 }), 'x'.repeat(MAX_SESSION_BYTES + 1)]) {
    await fs.writeFile(filename, text);
    const loaded = store.load();
    assert.equal(loaded.session, null);
    assert.equal(typeof loaded.sessionWarning, 'string');
    assert.equal(await fs.readFile(filename, 'utf8'), text);
  }
});

test('invalid or unwritable saves retain the previous valid session', async t => {
  const directory = await fixture(t);
  const store = createSessionStore(directory);
  const original = sessionWith('C:\\fixture');
  store.save(original);
  assert.throws(() => store.save({ version: 2 }), { code: 'INVALID_SESSION' });
  const oversizedPath = structuredClone(original);
  oversizedPath.workspaces.design.panes[0].path = `C:\\${'한'.repeat(32768)}`;
  assert.throws(() => store.save(oversizedPath), { code: 'INVALID_SESSION' });
  assert.deepEqual(store.load(), { session: original });
  await fs.mkdir(path.join(directory, `.session-${process.pid}.tmp`));
  assert.throws(() => store.save(original), { code: 'SESSION_WRITE_FAILED' });
  assert.deepEqual(store.load(), { session: original });
});
