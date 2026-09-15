'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { normalizePath } = require('./filesystem.cjs');

const messages = {
  INVALID_TRANSFER: '복사 또는 이동할 항목과 대상 폴더를 확인해 주세요.',
  INVALID_PATH: '올바른 전체 경로를 입력해 주세요.',
  TRANSFER_BUSY: '다른 복사 또는 이동 작업이 진행 중입니다. 완료 후 다시 시도해 주세요.',
  EEXIST: '대상에 같은 이름의 항목이 있어 건너뛰었습니다. 기존 항목은 변경하지 않았습니다.',
  SAME_LOCATION: '원본과 대상 위치가 같아 건너뛰었습니다.',
  DESCENDANT_TARGET: '폴더를 자기 자신이나 그 하위 폴더로 복사하거나 이동할 수 없습니다.',
  LINK_NOT_SUPPORTED: '링크 또는 정션이 포함된 경로는 복사·이동할 수 없습니다. 실제 폴더를 선택해 주세요.',
  ROOT_NOT_SUPPORTED: '드라이브 또는 공유 폴더 전체는 이동할 수 없습니다. 내부 항목을 선택해 주세요.',
  UNSUPPORTED_TYPE: '일반 파일과 폴더만 복사·이동할 수 있습니다.',
  SOURCE_CHANGED: '작업 중 원본이 변경되었습니다. 원본을 확인한 뒤 다시 시도해 주세요.',
  ENOENT: '원본 또는 대상 폴더를 찾을 수 없습니다.',
  ENOTDIR: '대상은 폴더여야 합니다.',
  EACCES: '파일 또는 폴더에 접근할 권한이 없습니다.',
  EPERM: '파일 또는 폴더에 접근할 권한이 없습니다.',
  EBUSY: '다른 프로그램이 사용 중인 항목입니다. 사용을 마친 뒤 다시 시도해 주세요.',
  ENOSPC: '대상 드라이브에 공간이 부족합니다.',
  ENAMETOOLONG: '경로가 너무 깁니다. 더 짧은 대상 경로를 선택해 주세요.',
  TRANSFER_FAILED: '복사 또는 이동을 완료하지 못했습니다. 경로, 권한과 드라이브 연결을 확인해 주세요.',
};

function failure(code, message) { return Object.assign(new Error(message || messages[code] || messages.TRANSFER_FAILED), { code }); }
function transferError(error) {
  const code = Object.hasOwn(messages, error?.code) || ['PARTIAL_MOVE', 'COPY_CLEANUP_FAILED'].includes(error?.code) ? error.code : 'TRANSFER_FAILED';
  return { code, message: ['PARTIAL_MOVE', 'COPY_CLEANUP_FAILED'].includes(code) ? error.message : messages[code] };
}
function key(value) { return value.toLowerCase(); }
function within(child, parent) { return key(child) === key(parent) || key(child).startsWith(`${key(parent).replace(/\\$/u, '')}\\`); }

function mutationPath(input) {
  // Address-bar conveniences must never change the spelling of a selected entry.
  if (typeof input !== 'string' || input !== input.trim() || input.includes('"')) throw failure('INVALID_PATH');
  const value = normalizePath(input);
  const root = path.win32.parse(value).root;
  // Win32 aliases such as "name." and DOS device names must not select a different entry.
  const parts = value.slice(root.length).split('\\').filter(Boolean);
  if (parts.some(part => /[ .]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part))) throw failure('INVALID_PATH');
  return value;
}

function validateTransfer(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !['copy', 'move'].includes(input.operation) || !Array.isArray(input.sources)
    || input.sources.length < 1 || input.sources.length > 1000) throw failure('INVALID_TRANSFER');
  const sources = [...new Map(input.sources.map(source => { const normalized = mutationPath(source); return [key(normalized), normalized]; })).values()];
  return { sources, destination: mutationPath(input.destination), operation: input.operation };
}

async function exists(value) { try { await fs.lstat(value); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function noLinkAncestors(value) {
  let current = value;
  for (;;) {
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw failure('LINK_NOT_SUPPORTED');
    const parent = path.win32.dirname(current);
    if (key(parent) === key(current)) break;
    current = parent;
  }
}
function sameIdentity(a, b) { return a.dev === b.dev && a.ino === b.ino && a.isDirectory() === b.isDirectory(); }
function sameFile(a, b) { return sameIdentity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs; }

async function inspectTree(source) {
  const records = [];
  const pending = [source];
  while (pending.length) {
    const filename = pending.pop();
    const stat = await fs.lstat(filename);
    if (stat.isSymbolicLink()) throw failure('LINK_NOT_SUPPORTED');
    if (!stat.isDirectory() && !stat.isFile()) throw failure('UNSUPPORTED_TYPE');
    records.push({ path: filename, stat });
    if (stat.isDirectory()) {
      for (const name of await fs.readdir(filename)) pending.push(mutationPath(path.win32.join(filename, name)));
    }
  }
  return records;
}

// Constant script; user-controlled paths are JSON data on stdin, never shell source.
// File.Move and Directory.Move refuse replacement. VB MoveDirectory provides cross-volume moves.
const moveScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.mode -eq 'file') { [IO.File]::Move($request.source, $request.destination) }
  elseif ($request.mode -eq 'directory') { [IO.Directory]::Move($request.source, $request.destination) }
  elseif ($request.mode -eq 'tree') {
    Add-Type -AssemblyName Microsoft.VisualBasic
    [Microsoft.VisualBasic.FileIO.FileSystem]::MoveDirectory($request.source, $request.destination, $false)
  } else { throw 'Invalid move mode' }
  [Console]::Out.Write('{"ok":true}')
} catch {
  $cause = $_.Exception
  while ($cause.InnerException) { $cause = $cause.InnerException }
  [Console]::Out.Write((@{ok=$false;win32=($cause.HResult -band 65535)} | ConvertTo-Json -Compress))
}
`;

function nativeMove(source, destination, mode) {
  if (process.platform !== 'win32') return Promise.reject(failure('TRANSFER_FAILED'));
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', moveScript], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.resume();
    child.on('error', reject);
    child.stdin.on('error', () => {});
    child.on('close', code => {
      try {
        const result = JSON.parse(output.replace(/^\uFEFF/u, ''));
        if (code === 0 && result.ok) return resolve();
        const mapped = { 2: 'ENOENT', 3: 'ENOENT', 5: 'EACCES', 17: 'EXDEV', 32: 'EBUSY', 33: 'EBUSY', 80: 'EEXIST', 112: 'ENOSPC', 183: 'EEXIST', 206: 'ENAMETOOLONG' }[result.win32];
        reject(failure(mapped || 'TRANSFER_FAILED'));
      } catch { reject(failure('TRANSFER_FAILED')); }
    });
    child.stdin.end(JSON.stringify({ source, destination, mode }), 'utf8');
  });
}

async function copyFileRecord(record, target, created) {
  await noLinkAncestors(record.path);
  const source = await fs.open(record.path, 'r');
  try {
    if (!sameFile(await source.stat(), record.stat)) throw failure('SOURCE_CHANGED');
    // Windows' native CopyFile preserves NTFS streams (including Zone.Identifier),
    // timestamps and attributes. Copying only the unnamed byte stream loses file data.
    await fs.copyFile(record.path, target, fs.constants.COPYFILE_EXCL);
    const copied = await fs.lstat(target);
    created.push({ path: target, stat: copied });
    const current = await fs.lstat(record.path);
    if (current.isSymbolicLink() || copied.isSymbolicLink()
      || !sameFile(current, record.stat) || !sameFile(await source.stat(), record.stat)
      || copied.size !== record.stat.size) throw failure('SOURCE_CHANGED');
  } finally { await source.close(); }
}

async function cleanupCreated(created, stage) {
  let clean = true;
  for (const entry of [...created].reverse()) {
    if (!within(entry.path, stage)) { clean = false; continue; }
    try {
      const current = await fs.lstat(entry.path);
      if (current.isSymbolicLink() || !sameIdentity(current, entry.stat)) { clean = false; continue; }
      await noLinkAncestors(entry.path);
      // Only remove entries exclusively created for this staged copy. Never recursively delete.
      if (current.isDirectory()) await fs.rmdir(entry.path); else await fs.unlink(entry.path);
    } catch (error) { if (error.code !== 'ENOENT') clean = false; }
  }
  return clean;
}

async function stagedCopy(records, source, destination, target, move, copy) {
  const stage = path.win32.join(destination, `.pane-copy-${randomUUID()}`);
  const payload = path.win32.join(stage, 'content');
  const created = [];
  await fs.mkdir(stage);
  created.push({ path: stage, stat: await fs.lstat(stage) });
  let published = false;
  try {
    for (const record of records) {
      await noLinkAncestors(destination);
      const targetPath = path.win32.join(payload, path.win32.relative(source, record.path));
      if (record.stat.isDirectory()) {
        await fs.mkdir(targetPath);
        created.push({ path: targetPath, stat: await fs.lstat(targetPath) });
      } else await copy(record, targetPath, created);
    }
    const after = await inspectTree(source);
    const afterByPath = new Map(after.map(item => [key(item.path), item]));
    if (after.length !== records.length || records.some(record => {
      const current = afterByPath.get(key(record.path));
      return !current || !(record.stat.isDirectory() ? sameIdentity(current.stat, record.stat) : sameFile(current.stat, record.stat));
    })) throw failure('SOURCE_CHANGED');
    await noLinkAncestors(destination);
    await move(payload, target, records[0].stat.isDirectory() ? 'directory' : 'file');
    published = true;
  } finally {
    const clean = await cleanupCreated(published ? created.slice(0, 1) : created, stage);
    if (!clean && !published) throw failure('COPY_CLEANUP_FAILED', `복사를 완료하지 못했습니다. 원본은 유지되었으며 임시 사본이 ${stage} 에 남아 있습니다.`);
  }
}

function createTransferService(options = {}) {
  const move = options.nativeMove || nativeMove;
  const copy = options.copyFile || copyFileRecord;
  let active;
  async function run(input) {
    const request = validateTransfer(input);
    const destination = request.destination;
    await noLinkAncestors(destination);
    const destinationStat = await fs.stat(destination);
    if (!destinationStat.isDirectory()) throw failure('ENOTDIR');
    const canonicalDestination = await fs.realpath(destination);
    const result = { operation: request.operation, completed: [], skipped: [], failed: [] };
    for (const source of request.sources) {
      const target = path.win32.join(destination, path.win32.basename(source));
      let crossVolumeStarted = false;
      let moveStarted = false;
      try {
        if (key(source) === key(path.win32.parse(source).root)) throw failure('ROOT_NOT_SUPPORTED');
        await noLinkAncestors(source);
        await noLinkAncestors(destination);
        const canonicalSource = await fs.realpath(source);
        const canonicalTarget = path.win32.join(canonicalDestination, path.win32.basename(source));
        if (key(canonicalSource) === key(canonicalTarget)) throw failure('SAME_LOCATION');
        const records = await inspectTree(source);
        if (records[0].stat.isDirectory() && within(canonicalDestination, canonicalSource)) throw failure('DESCENDANT_TARGET');
        if (await exists(target)) throw failure('EEXIST');
        if (request.operation === 'copy') {
          await stagedCopy(records, source, destination, target, move, copy);
        } else {
          moveStarted = true;
          const directory = records[0].stat.isDirectory();
          const crossVolume = records[0].stat.dev !== destinationStat.dev
            || key(path.win32.parse(canonicalSource).root) !== key(path.win32.parse(canonicalDestination).root);
          try {
            // Directory.Move can report a generic IOException for a drive change in .NET Framework.
            if (directory && crossVolume) throw failure('EXDEV');
            await move(source, target, directory ? 'directory' : 'file');
          }
          catch (error) {
            if (error.code !== 'EXDEV' || !records[0].stat.isDirectory()) throw error;
            await noLinkAncestors(source);
            await noLinkAncestors(destination);
            await inspectTree(source);
            // Reserve an empty destination exclusively; the library may not merge into any existing user folder.
            await fs.mkdir(target);
            crossVolumeStarted = true;
            await move(source, target, 'tree');
          }
          if (await exists(source)) throw failure('PARTIAL_MOVE', `대상 사본은 ${target} 에 있지만 원본도 남아 있습니다. 두 위치를 확인해 주세요.`);
        }
        result.completed.push({ source, destination: target });
      } catch (error) {
        if (moveStarted && (crossVolumeStarted || (error.code !== 'EEXIST' && await exists(target).catch(() => false)))) {
          error = failure('PARTIAL_MOVE', `이동이 일부만 완료되었을 수 있습니다. 남은 원본 ${source} 과 대상 ${target} 을 확인해 주세요. 두 위치의 항목을 자동으로 삭제하지 않았습니다.`);
        }
        const detail = { source, ...transferError(error) };
        (['EEXIST', 'SAME_LOCATION', 'DESCENDANT_TARGET', 'LINK_NOT_SUPPORTED', 'ROOT_NOT_SUPPORTED'].includes(detail.code) ? result.skipped : result.failed).push(detail);
      }
    }
    return result;
  }
  return {
    transfer(input) {
      if (active) return Promise.reject(failure('TRANSFER_BUSY'));
      const pending = run(input);
      active = pending;
      pending.finally(() => { if (active === pending) active = undefined; }).catch(() => {});
      return pending;
    },
    get pending() { return active; },
  };
}

module.exports = { createTransferService, validateTransfer, mutationPath, nativeMove, transferError, copyFileRecord };
