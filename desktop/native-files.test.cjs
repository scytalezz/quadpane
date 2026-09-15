'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
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
  const folder = result.entries.find(entry => entry.name === '비어 있는 폴더');
  assert.equal(folder.type, 'folder');
  assert.equal(folder.size, null);
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
  assert.equal((await listDirectory(link)).entries.length, 321);
});

test('favorites use provided OS known-folder locations and error messages hide raw failures', () => {
  const favorites = getFavorites(name => {
    if (name === 'desktop') throw new Error('Unavailable known folder');
    return `D:\\redirected\\${name}`;
  });
  assert.deepEqual(favorites.map(favorite => favorite.id), ['home', 'downloads', 'documents', 'pictures']);
  assert.equal(favorites[1].path, 'D:\\redirected\\downloads');
  assert.equal(favorites[3].icon, 'image');
  for (const code of ['ENOENT', 'EACCES', 'ENOTDIR', 'EIO', 'ETIMEDOUT']) {
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
