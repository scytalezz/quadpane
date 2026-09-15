'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { mutationPath, nativeMove } = require('./file-operations.cjs');

const messages = {
  INVALID_ACTION: '작업할 항목을 확인해 주세요.',
  INVALID_PATH: '올바른 전체 파일 또는 폴더 경로를 입력해 주세요.',
  INVALID_NAME: '이름에는 Windows에서 사용할 수 없는 문자, 예약 이름 또는 끝의 공백·마침표를 사용할 수 없습니다.',
  ACTION_BUSY: '다른 파일 작업이 진행 중입니다. 완료 후 다시 시도해 주세요.',
  ROOT_NOT_SUPPORTED: '드라이브 또는 공유 폴더의 최상위 경로에는 이 작업을 할 수 없습니다.',
  LINK_NOT_SUPPORTED: '링크 또는 정션 경로에서는 이 작업을 할 수 없습니다. 실제 폴더를 선택해 주세요.',
  UNSUPPORTED_TYPE: '일반 파일과 폴더만 선택해 주세요.',
  NOT_FILE: '기본 앱으로 열 파일을 선택해 주세요.',
  ENOENT: '파일 또는 폴더를 찾을 수 없습니다. 새로 고침한 뒤 다시 시도해 주세요.',
  ENOTDIR: '새 폴더를 만들 위치는 폴더여야 합니다.',
  EEXIST: '같은 이름의 항목이 이미 있습니다. 다른 이름을 입력해 주세요.',
  EACCES: '이 파일 또는 폴더를 변경할 권한이 없습니다.',
  EPERM: '이 파일 또는 폴더를 변경할 권한이 없습니다.',
  EBUSY: '다른 프로그램이 사용 중인 항목입니다. 사용을 마친 뒤 다시 시도해 주세요.',
  ENOSPC: '드라이브에 공간이 부족합니다.',
  ENAMETOOLONG: '이름 또는 경로가 너무 깁니다.',
  SOURCE_CHANGED: '작업 중 항목이 변경되었습니다. 새로 고침한 뒤 다시 시도해 주세요.',
  PARENT_SELECTED: '함께 선택한 상위 폴더에 포함되어 따로 처리하지 않았습니다.',
  OPEN_FAILED: '기본 앱으로 파일을 열지 못했습니다. 연결된 앱과 파일 상태를 확인해 주세요.',
  TRASH_FAILED: '휴지통으로 보내지 못했습니다. 원본을 확인해 주세요. 영구 삭제는 수행하지 않았습니다.',
  ACTION_FAILED: '작업을 완료하지 못했습니다. 경로, 권한과 드라이브 연결을 확인해 주세요.',
};

function failure(code, message) { return Object.assign(new Error(message || messages[code] || messages.ACTION_FAILED), { code }); }
function actionError(error) {
  if (error?.code === 'RENAME_RECOVERY_REQUIRED') return { code: error.code, message: error.message };
  const code = Object.hasOwn(messages, error?.code) ? error.code : 'ACTION_FAILED';
  return { code, message: messages[code] };
}
function key(value) { return value.toLowerCase(); }
function within(child, parent) { return key(child).startsWith(`${key(parent).replace(/\\$/u, '')}\\`); }
function sameIdentity(a, b) { return a.dev === b.dev && a.ino === b.ino && a.isDirectory() === b.isDirectory(); }

function validateName(value) {
  if (typeof value !== 'string' || !value.length || value.length > 255 || ['.', '..'].includes(value)
    || /[\u0000-\u001f\\/:"<>|?*]/u.test(value) || /[ .]$/u.test(value)
    || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(value)) throw failure('INVALID_NAME');
  return value;
}

function itemPath(value) {
  const filename = mutationPath(value);
  if (key(filename) === key(path.win32.parse(filename).root)) throw failure('ROOT_NOT_SUPPORTED');
  return filename;
}

function validatePaths(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 1000) throw failure('INVALID_ACTION');
  return [...new Map(input.map(value => { const filename = itemPath(value); return [key(filename), filename]; })).values()];
}

async function noLinkAncestors(filename) {
  let current = filename;
  for (;;) {
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw failure('LINK_NOT_SUPPORTED');
    const parent = path.win32.dirname(current);
    if (key(parent) === key(current)) return;
    current = parent;
  }
}

async function inspectItem(filename) {
  await noLinkAncestors(filename);
  const stat = await fs.lstat(filename);
  if (!stat.isFile() && !stat.isDirectory()) throw failure('UNSUPPORTED_TYPE');
  return stat;
}

async function unchanged(filename, before) {
  await noLinkAncestors(filename);
  if (!sameIdentity(await fs.lstat(filename), before)) throw failure('SOURCE_CHANGED');
}

function createMutationCoordinator() {
  let active;
  return {
    run(action) {
      if (active) return Promise.reject(failure('ACTION_BUSY'));
      const pending = Promise.resolve().then(action);
      active = pending;
      pending.finally(() => { if (active === pending) active = undefined; }).catch(() => {});
      return pending;
    },
    get pending() { return active; },
  };
}

function createExplorerActions(options) {
  const shell = options.shell;
  const move = options.nativeMove || nativeMove;
  const mutations = options.mutations || createMutationCoordinator();

  async function trash(request) {
    // Validate every path before shell.trashItem can change any item.
    const paths = validatePaths(request?.paths);
    const result = { operation: 'trash', completed: [], skipped: [], failed: [] };
    const selected = paths.filter(source => {
      if (!paths.some(parent => parent !== source && within(source, parent))) return true;
      result.skipped.push({ source, ...actionError(failure('PARENT_SELECTED')) });
      return false;
    });
    const records = [];
    for (const source of selected) {
      try { records.push({ source, stat: await inspectItem(source) }); }
      catch (error) { result.failed.push({ source, ...actionError(error) }); }
    }
    for (const { source, stat } of records) {
      try {
        await unchanged(source, stat);
        // Electron's Windows PreDeleteItem aborts if the item cannot be recycled.
        // Never fall back to unlink/rm (including network and removable volumes).
        try { await shell.trashItem(source); }
        catch (error) { throw failure(Object.hasOwn(messages, error?.code) ? error.code : 'TRASH_FAILED'); }
        result.completed.push({ source });
      } catch (error) { result.failed.push({ source, ...actionError(error) }); }
    }
    return result;
  }

  async function rename(request) {
    const source = itemPath(request?.path);
    const name = validateName(request?.name);
    const target = mutationPath(path.win32.join(path.win32.dirname(source), name));
    const stat = await inspectItem(source);
    if (source === target) return { source, path: target };
    await unchanged(source, stat);
    const mode = stat.isDirectory() ? 'directory' : 'file';
    if (key(source) !== key(target)) {
      // The Windows native move refuses replacement, including a concurrent destination creation.
      await move(source, target, mode);
    } else {
      // File.Move cannot reliably rename only casing. Both hops refuse replacement.
      const temporary = path.win32.join(path.win32.dirname(source), `.pane-rename-${randomUUID()}`);
      await move(source, temporary, mode);
      try { await move(temporary, target, mode); }
      catch (error) {
        try { await move(temporary, source, mode); }
        catch { throw failure('RENAME_RECOVERY_REQUIRED', `이름 변경을 마치지 못했습니다. 항목은 ${temporary} 에 보관되어 있습니다. 해당 경로와 원래 경로 ${source} 을 확인해 주세요.`); }
        throw error;
      }
    }
    return { source, path: target };
  }

  async function create(request) {
    const parent = mutationPath(request?.parent);
    const name = validateName(request?.name);
    const filename = mutationPath(path.win32.join(parent, name));
    await noLinkAncestors(parent);
    if (!(await fs.stat(parent)).isDirectory()) throw failure('ENOTDIR');
    await fs.mkdir(filename); // Exclusive creation; no recursive merge into an existing folder.
    return { path: filename };
  }

  return {
    async openPath(input) {
      const filename = mutationPath(input);
      if (!(await fs.stat(filename)).isFile()) throw failure('NOT_FILE');
      try { if (await shell.openPath(filename)) throw failure('OPEN_FAILED'); }
      catch { throw failure('OPEN_FAILED'); }
      return null;
    },
    async revealPath(input) {
      const filename = mutationPath(input);
      await fs.stat(filename);
      shell.showItemInFolder(filename);
      return null;
    },
    async prepareNativeDrag(input) {
      const paths = validatePaths(input);
      for (const filename of paths) await inspectItem(filename);
      return paths;
    },
    trashItems: request => mutations.run(() => trash(request)),
    renameItem: request => mutations.run(() => rename(request)),
    createFolder: request => mutations.run(() => create(request)),
    get pending() { return mutations.pending; },
  };
}

module.exports = { createExplorerActions, createMutationCoordinator, validateName, validatePaths, actionError };
