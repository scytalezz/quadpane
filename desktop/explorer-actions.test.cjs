'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createExplorerActions, createMutationCoordinator, validateName, validatePaths, actionError } = require('./explorer-actions.cjs');
const base = path.join(__dirname, '..', '.checks', 'explorer-action-tests');

async function fixture() {
  await fs.mkdir(base, { recursive: true });
  return fs.mkdtemp(path.join(base, 'run-'));
}
function service(overrides = {}) {
  return createExplorerActions({ shell: { openPath: async () => '', showItemInFolder() {}, trashItem: async () => {} }, ...overrides });
}
async function missing(filename) { await assert.rejects(fs.lstat(filename), { code: 'ENOENT' }); }

test('trailing-space NTFS entry never redirects trash, rename or transfer to the plain filename', async () => {
  const root = await fixture();
  const plain = path.join(root, 'file.txt');
  const trailing = `${plain} `;
  const exactTrailing = path.toNamespacedPath(trailing);
  await fs.writeFile(plain, 'plain bytes');
  await fs.writeFile(exactTrailing, 'distinct trailing bytes');
  assert.ok((await fs.readdir(root)).includes('file.txt '));
  const calls = [];
  const actions = service({ shell: { trashItem: async filename => calls.push(filename) } });
  await assert.rejects(actions.trashItems({ paths: [trailing] }), { code: 'INVALID_PATH' });
  await assert.rejects(actions.renameItem({ path: trailing, name: 'renamed.txt' }), { code: 'INVALID_PATH' });
  const { validateTransfer } = require('./file-operations.cjs');
  assert.throws(() => validateTransfer({ sources: [trailing], destination: root, operation: 'copy' }), { code: 'INVALID_PATH' });
  assert.throws(() => validatePaths([`"${plain}"`]), { code: 'INVALID_PATH' });
  assert.deepEqual(calls, []);
  assert.equal(await fs.readFile(plain, 'utf8'), 'plain bytes');
  assert.equal(await fs.readFile(exactTrailing, 'utf8'), 'distinct trailing bytes');
});

test('action validation rejects roots, protocols, aliases and every invalid Windows filename form', () => {
  for (const name of ['', '.', '..', 'a/b', 'a\\b', 'stream:ads', 'name.', 'name ', 'NUL.txt', 'com1', 'LPT².txt', 'x?y', 'x\u0000', 'x'.repeat(256), 123, null]) {
    assert.throws(() => validateName(name), { code: 'INVALID_NAME' });
  }
  assert.equal(validateName("한글 client's & report.txt"), "한글 client's & report.txt");
  for (const filename of ['C:\\', '\\\\server\\share', 'C:relative', 'https://example.com', '\\\\.\\C:', 'C:\\work\\NUL.txt', 'C:\\work\\name.']) {
    assert.throws(() => validatePaths([filename]));
  }
  assert.throws(() => validatePaths([]), { code: 'INVALID_ACTION' });
  assert.throws(() => validatePaths(new Array(1001).fill('C:\\work')), { code: 'INVALID_ACTION' });
  assert.equal(validatePaths(['C:\\work', 'c:\\WORK']).length, 1);
});

test('new folder is empty and exclusive, preserving both existing files and directories', async () => {
  const root = await fixture();
  const actions = service();
  const created = await actions.createFolder({ parent: root, name: '한글 새 폴더' });
  assert.deepEqual(await fs.readdir(created.path), []);
  await assert.rejects(actions.createFolder({ parent: root, name: '한글 새 폴더' }), { code: 'EEXIST' });
  const existing = path.join(root, 'existing.txt');
  await fs.writeFile(existing, 'keep');
  await assert.rejects(actions.createFolder({ parent: root, name: 'existing.txt' }), { code: 'EEXIST' });
  await assert.rejects(actions.createFolder({ parent: existing, name: 'child' }), { code: 'ENOTDIR' });
  assert.equal(await fs.readFile(existing, 'utf8'), 'keep');
});

test('native rename preserves Unicode file bytes and nested folders, refuses overwrite', async () => {
  const root = await fixture();
  const source = path.join(root, "한글 client's & source.txt");
  const occupied = path.join(root, 'occupied.txt');
  await fs.writeFile(source, 'rename me');
  await fs.writeFile(occupied, 'never replace');
  const actions = service();
  await assert.rejects(actions.renameItem({ path: source, name: 'occupied.txt' }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(source, 'utf8'), 'rename me');
  assert.equal(await fs.readFile(occupied, 'utf8'), 'never replace');
  const result = await actions.renameItem({ path: source, name: 'renamed 한글.txt' });
  await missing(source);
  assert.equal(await fs.readFile(result.path, 'utf8'), 'rename me');
  const folder = path.join(root, 'folder');
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'child.txt'), 'child');
  const renamed = await actions.renameItem({ path: folder, name: 'renamed folder' });
  await missing(folder);
  assert.equal(await fs.readFile(path.join(renamed.path, 'child.txt'), 'utf8'), 'child');
});

test('native case-only rename changes directory entry spelling without data loss or staging leftovers', async () => {
  const root = await fixture();
  const source = path.join(root, 'MixedCase.txt');
  await fs.writeFile(source, 'case-only');
  const actions = service();
  const result = await actions.renameItem({ path: source, name: 'MIXEDCASE.TXT' });
  assert.deepEqual(await fs.readdir(root), ['MIXEDCASE.TXT']);
  assert.equal(await fs.readFile(result.path, 'utf8'), 'case-only');
  assert.deepEqual(await actions.renameItem({ path: result.path, name: 'MIXEDCASE.TXT' }), { source: result.path, path: result.path });
});

test('failed case-only rename rolls back; failed rollback preserves a named recovery file', async () => {
  const root = await fixture();
  const source = path.join(root, 'case.txt');
  await fs.writeFile(source, 'recoverable');
  let calls = 0;
  const recovering = service({ nativeMove: async (from, to) => {
    if (++calls === 2) throw Object.assign(new Error('injected failure'), { code: 'EBUSY' });
    await fs.rename(from, to);
  } });
  await assert.rejects(recovering.renameItem({ path: source, name: 'CASE.TXT' }), { code: 'EBUSY' });
  assert.equal(await fs.readFile(source, 'utf8'), 'recoverable');
  assert.deepEqual(await fs.readdir(root), ['case.txt']);
  calls = 0;
  const blocked = service({ nativeMove: async (from, to) => {
    if (++calls > 1) throw Object.assign(new Error('injected failure'), { code: 'EBUSY' });
    await fs.rename(from, to);
  } });
  let recoveryError;
  await assert.rejects(blocked.renameItem({ path: source, name: 'CASE.TXT' }), error => { recoveryError = error; return error.code === 'RENAME_RECOVERY_REQUIRED'; });
  const entries = await fs.readdir(root);
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^\.pane-rename-/u);
  assert.equal(await fs.readFile(path.join(root, entries[0]), 'utf8'), 'recoverable');
  assert.ok(actionError(recoveryError).message.includes(path.join(root, entries[0])));
});

test('trash validates the entire request before shell calls and collapses child selections', async () => {
  const root = await fixture();
  const folder = path.join(root, 'folder');
  const child = path.join(folder, 'child.txt');
  const other = path.join(root, 'other.txt');
  await fs.mkdir(folder);
  await fs.writeFile(child, 'child');
  await fs.writeFile(other, 'other');
  const calls = [];
  const actions = service({ shell: { trashItem: async filename => { calls.push(filename); } } });
  await assert.rejects(actions.trashItems({ paths: [other, path.parse(root).root] }), { code: 'ROOT_NOT_SUPPORTED' });
  await assert.rejects(actions.trashItems({ paths: [other, 'https://example.com'] }), { code: 'INVALID_PATH' });
  assert.deepEqual(calls, []);
  const result = await actions.trashItems({ paths: [child, folder, other, other.toUpperCase()] });
  assert.equal(result.operation, 'trash');
  assert.equal(result.completed.length, 2);
  assert.deepEqual(calls.map(value => value.toLowerCase()).sort(), [folder, other].map(value => value.toLowerCase()).sort());
  assert.equal(result.skipped[0].source, child);
  assert.equal(result.skipped[0].code, 'PARENT_SELECTED');
});

test('trash rejection leaves original content untouched, reports failures and continues independent items', async () => {
  const root = await fixture();
  const good = path.join(root, 'good.txt');
  const failed = path.join(root, 'keep.txt');
  const absent = path.join(root, 'missing.txt');
  await fs.writeFile(good, 'good');
  await fs.writeFile(failed, 'preserved');
  const calls = [];
  const actions = service({ shell: { trashItem: async filename => {
    calls.push(filename);
    if (filename === failed) throw new Error('No recycle bin');
  } } });
  const result = await actions.trashItems({ paths: [failed, absent, good] });
  assert.equal(result.completed.length, 1);
  assert.equal(result.completed[0].source, good);
  assert.deepEqual(result.failed.map(item => item.code).sort(), ['ENOENT', 'TRASH_FAILED']);
  assert.equal(await fs.readFile(failed, 'utf8'), 'preserved');
  assert.deepEqual(calls, [failed, good]);
});

test('open/reveal/native drag validate real paths and forward only expected local filenames', async () => {
  const root = await fixture();
  const file = path.join(root, 'document.txt');
  await fs.writeFile(file, 'document');
  const opened = [], revealed = [];
  const actions = service({ shell: {
    openPath: async filename => { opened.push(filename); return ''; },
    showItemInFolder: filename => { revealed.push(filename); },
  } });
  assert.equal(await actions.openPath(file), null);
  assert.equal(await actions.revealPath(file), null);
  assert.deepEqual(opened, [file]);
  assert.deepEqual(revealed, [file]);
  await assert.rejects(actions.openPath(root), { code: 'NOT_FILE' });
  await assert.rejects(actions.openPath('https://example.com'), { code: 'INVALID_PATH' });
  await assert.rejects(actions.openPath(path.join(root, 'missing.txt')), { code: 'ENOENT' });
  assert.deepEqual(await actions.prepareNativeDrag([file, file.toUpperCase()]), [file.toUpperCase()]);
  await assert.rejects(actions.prepareNativeDrag([path.parse(root).root]), { code: 'ROOT_NOT_SUPPORTED' });
  const failed = service({ shell: { openPath: async () => 'No association' } });
  await assert.rejects(failed.openPath(file), { code: 'OPEN_FAILED' });
  const rejected = service({ shell: { openPath: async () => { throw new Error('OS failure'); } } });
  await assert.rejects(rejected.openPath(file), { code: 'OPEN_FAILED' });
});

test('junction paths cannot rename/create/trash a linked target', async () => {
  const root = await fixture();
  const actual = path.join(root, 'actual');
  const link = path.join(root, 'link');
  await fs.mkdir(actual);
  const file = path.join(actual, 'file.txt');
  await fs.writeFile(file, 'unchanged');
  await fs.symlink(actual, link, 'junction');
  const calls = [];
  const actions = service({ shell: { trashItem: async filename => calls.push(filename) } });
  await assert.rejects(actions.renameItem({ path: path.join(link, 'file.txt'), name: 'renamed' }), { code: 'LINK_NOT_SUPPORTED' });
  await assert.rejects(actions.createFolder({ parent: link, name: 'child' }), { code: 'LINK_NOT_SUPPORTED' });
  const trash = await actions.trashItems({ paths: [link] });
  assert.equal(trash.failed[0].code, 'LINK_NOT_SUPPORTED');
  assert.deepEqual(calls, []);
  assert.equal(await fs.readFile(file, 'utf8'), 'unchanged');
});

test('shared mutation coordinator excludes concurrent transfers and actions and exposes pending completion', async () => {
  const root = await fixture();
  const file = path.join(root, 'file.txt');
  await fs.writeFile(file, 'content');
  const mutations = createMutationCoordinator();
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const actions = service({ mutations, shell: { trashItem: async () => barrier } });
  const pending = actions.trashItems({ paths: [file] });
  assert.equal(mutations.pending, pending);
  assert.equal(actions.pending, pending);
  await assert.rejects(mutations.run(() => { throw new Error('should not reach transfer'); }), { code: 'ACTION_BUSY' });
  await assert.rejects(actions.createFolder({ parent: root, name: 'blocked' }), { code: 'ACTION_BUSY' });
  release();
  await pending;
  assert.equal(mutations.pending, undefined);
  const created = await actions.createFolder({ parent: root, name: 'after completion' });
  assert.deepEqual(await fs.readdir(created.path), []);
  await assert.rejects(mutations.run(() => { throw new Error('action failed'); }), /action failed/u);
  assert.equal(mutations.pending, undefined);
});
