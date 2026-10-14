'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { execFile, execFileSync } = require('node:child_process');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const { normalizePath, locationDetails, listDirectory, getFavorites, errorResult } = require('./filesystem.cjs');
const { createSessionStore, validateSession, MAX_SESSION_BYTES } = require('./session-store.cjs');

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

async function filesystemWithProcess(run) {
  const module = { exports: {} };
  vm.runInNewContext(await fs.readFile(path.join(__dirname, 'filesystem.cjs'), 'utf8'), {
    module, process, setTimeout, clearTimeout,
    require: name => name === 'node:child_process' ? { execFile: run } : require(name),
  });
  return module.exports;
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
  let launches = 0;
  const batched = await filesystemWithProcess((...args) => { launches++; return execFile(...args); });
  const linkedListing = await batched.listDirectory(link);
  assert.equal(linkedListing.entries.length, 321);
  assert.ok(linkedListing.entries.every(entry => entry.hidden === false));
  assert.equal(launches, 1, 'one attribute process for the entire directory');
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

test('empty directories do not launch an attribute process', async t => {
  const directory = await fixture(t);
  let launches = 0;
  const injected = await filesystemWithProcess(() => { launches++; throw new Error('Must not launch'); });
  assert.equal((await injected.listDirectory(directory)).entries.length, 0);
  assert.equal(launches, 0);
});

test('attribute requests send paths only through UTF-8 JSON stdin and keep the command constant', async t => {
  const directory = await fixture(t);
  const filename = path.join(directory, "한글 [literal] & ' $(throw 42) `.txt");
  await fs.writeFile(filename, 'data');
  const requests = [];
  const injected = await filesystemWithProcess((executable, args, options, callback) => {
    const child = { stdin: new PassThrough(), kill() {} };
    let input = '';
    child.stdin.setEncoding('utf8').on('data', data => { input += data; });
    child.stdin.on('finish', () => {
      requests.push({ executable, args, options, input });
      const paths = JSON.parse(input);
      callback(null, '\uFEFF' + JSON.stringify(paths.map(() => true)));
    });
    return child;
  });
  assert.equal((await injected.listDirectory(directory)).entries[0].hidden, true);
  const other = await fixture(t);
  await fs.writeFile(path.join(other, 'other.txt'), 'other');
  await injected.listDirectory(other);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].args.at(-1), requests[1].args.at(-1));
  assert.deepEqual(JSON.parse(requests[0].input), [path.win32.toNamespacedPath(filename)]);
  assert.ok(!requests[0].args.some(argument => argument.includes(directory) || argument.includes(path.basename(filename))));
  assert.equal(requests[0].options.windowsHide, true);
  assert.equal(requests[0].options.encoding, 'utf8');
  assert.ok(requests[0].options.timeout > 0);
  assert.ok(!requests[0].options.shell);
});

test('metadata process and protocol failures reject the entire listing explicitly', async t => {
  const directory = await fixture(t);
  await fs.writeFile(path.join(directory, 'must-not-leak.txt'), 'data');
  for (const stdout of ['', 'not JSON', 'false', '{}', '[]', '[false, true]', '[0]', '["false"]', '[{"hidden":false}]']) {
    const injected = await filesystemWithProcess((_executable, _args, _options, callback) => {
      const child = { stdin: new PassThrough(), kill() {} };
      child.stdin.on('finish', () => callback(null, stdout));
      return child;
    });
    await assert.rejects(injected.listDirectory(directory), { code: 'METADATA_READ_FAILED' });
  }
  for (const failure of [{ code: 'ENOENT' }, { code: 1 }, { killed: true, signal: 'SIGTERM' }, { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }]) {
    const injected = await filesystemWithProcess((_executable, _args, _options, callback) => {
      const child = { stdin: new PassThrough(), kill() {} };
      child.stdin.on('finish', () => callback(Object.assign(new Error('raw private path'), failure), '[false]'));
      return child;
    });
    await assert.rejects(injected.listDirectory(directory), { code: 'METADATA_READ_FAILED' });
  }
  const thrown = await filesystemWithProcess(() => { throw new Error('spawn failed'); });
  await assert.rejects(thrown.listDirectory(directory), { code: 'METADATA_READ_FAILED' });
});

test('broken metadata input pipe rejects and terminates the process without an unhandled stream error', async t => {
  const directory = await fixture(t);
  await fs.writeFile(path.join(directory, 'entry.txt'), 'data');
  let killed = false;
  const injected = await filesystemWithProcess(() => {
    const child = { stdin: new PassThrough(), kill() { killed = true; } };
    child.stdin.on('finish', () => child.stdin.emit('error', Object.assign(new Error('broken'), { code: 'EPIPE' })));
    return child;
  });
  await assert.rejects(injected.listDirectory(directory), { code: 'METADATA_READ_FAILED' });
  assert.equal(killed, true);
});

test('an actual file disappearance during Windows attribute reading skips only that file', { skip: process.platform !== 'win32' }, async t => {
  const directory = await fixture(t);
  await fs.writeFile(path.join(directory, 'kept-hidden.txt'), 'hidden');
  await fs.writeFile(path.join(directory, 'kept-visible.txt'), 'visible');
  await fs.writeFile(path.join(directory, 'vanished.txt'), 'data');
  setHidden([path.join(directory, 'kept-hidden.txt')], true);
  const injected = await filesystemWithProcess((...args) => {
    // listDirectory already collected the stat; simulate a file disappearing
    // before the native attribute snapshot without replacing the real helper.
    require('node:fs').unlinkSync(path.join(directory, 'vanished.txt'));
    return execFile(...args);
  });
  const result = await injected.listDirectory(directory);
  assert.equal(result.skipped, 1);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries.find(entry => entry.name === 'kept-hidden.txt').hidden, true);
  assert.equal(result.entries.find(entry => entry.name === 'kept-visible.txt').hidden, false);
  assert.ok(!result.entries.some(entry => entry.name === 'vanished.txt'));
});

test('unavailable metadata and stat failures add to skipped without shifting flags or treating missing metadata as visible', async t => {
  const directory = await fixture(t);
  const names = ['a-unavailable.txt', 'b-hidden.txt', 'c-unavailable.txt', 'd-visible.txt', 'e-unavailable.txt'];
  await Promise.all(names.map(name => fs.writeFile(path.join(directory, name), 'data')));
  const stat = fs.stat;
  t.mock.method(fs, 'stat', (filename, ...args) => filename === path.join(directory, names[0])
    ? Promise.reject(Object.assign(new Error('No access'), { code: 'EACCES' })) : stat(filename, ...args));
  const injected = await filesystemWithProcess((_executable, _args, _options, callback) => {
    const child = { stdin: new PassThrough(), kill() {} };
    let input = '';
    child.stdin.setEncoding('utf8').on('data', data => { input += data; });
    child.stdin.on('finish', () => callback(null, JSON.stringify(JSON.parse(input).map(filename =>
      filename.includes('unavailable') ? null : filename.includes('hidden')))));
    return child;
  });
  const result = await injected.listDirectory(directory);
  assert.equal(result.skipped, 3);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries.find(entry => entry.name === 'b-hidden.txt').hidden, true);
  assert.equal(result.entries.find(entry => entry.name === 'd-visible.txt').hidden, false);
});

test('favorites use provided OS known-folder locations and error messages hide raw failures', () => {
  const favorites = getFavorites(name => {
    if (name === 'desktop') throw new Error('Unavailable known folder');
    return `D:\\redirected\\${name}`;
  });
  assert.deepEqual(favorites.map(favorite => favorite.id), ['home', 'downloads', 'documents', 'pictures']);
  assert.equal(favorites[1].path, 'D:\\redirected\\downloads');
  assert.equal(favorites[3].icon, 'image');
  for (const code of ['ENOENT', 'EACCES', 'ENOTDIR', 'EIO', 'ETIMEDOUT', 'METADATA_READ_FAILED']) {
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
