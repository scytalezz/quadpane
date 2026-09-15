'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');

function invalidPath() {
  const error = new Error('드라이브 또는 공유 폴더의 전체 경로를 입력해 주세요. 예: C:\\Users 또는 \\\\서버\\공유');
  error.code = 'INVALID_PATH';
  return error;
}

function normalizePath(input) {
  if (typeof input !== 'string' || input.length > 32767) throw invalidPath();
  let value = input.trim();
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  value = value.replaceAll('/', '\\');
  if (!value || /[\u0000-\u001f"<>|?*]/u.test(value)
    || /^\\\\[?.]\\/u.test(value) || /^\\\?\?\\/u.test(value)) throw invalidPath();
  const drive = /^[a-z]:\\/iu.test(value);
  const uncParts = /^\\\\([^\\:]+)\\([^\\:]+)(?:\\|$)/u.exec(value);
  const unc = Boolean(uncParts && !['.', '..'].includes(uncParts[1]) && !['.', '..'].includes(uncParts[2]));
  if (!drive && !unc) throw invalidPath();
  // Colons after the drive prefix denote alternate streams, not folders.
  if (value.slice(drive ? 2 : 0).includes(':')) throw invalidPath();
  const normalized = path.win32.normalize(value);
  const root = path.win32.parse(normalized).root;
  if (!root) throw invalidPath();
  const result = normalized.length > root.length ? normalized.replace(/\\+$/u, '') : normalized;
  return drive ? result[0].toUpperCase() + result.slice(1) : result;
}

function locationDetails(directory) {
  const root = path.win32.parse(directory).root;
  const rootName = root.replace(/\\$/u, '');
  const segments = directory.slice(root.length).split('\\').filter(Boolean);
  const breadcrumbs = [{ name: rootName, path: root }];
  let current = root;
  for (const name of segments) {
    current = path.win32.join(current, name);
    breadcrumbs.push({ name, path: current });
  }
  return {
    path: directory,
    name: segments.at(-1) || rootName,
    parent: directory.toLowerCase() === root.toLowerCase() ? null : path.win32.dirname(directory),
    breadcrumbs,
  };
}

async function mapLimit(items, concurrency, visit) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await visit(items[index]);
    }
  }));
  return results;
}

async function listDirectory(input) {
  const directory = normalizePath(input);
  const stat = await fs.stat(directory);
  if (!stat.isDirectory()) {
    const error = new Error('폴더 경로를 입력해 주세요.');
    error.code = 'ENOTDIR';
    throw error;
  }
  const children = await fs.readdir(directory, { withFileTypes: true });
  let skipped = 0;
  const entries = await mapLimit(children, 16, async child => {
    const childPath = path.win32.join(directory, child.name);
    try {
      const childStat = await fs.stat(childPath);
      if (!childStat.isDirectory() && !childStat.isFile()) {
        skipped++;
        return null;
      }
      return {
        path: childPath,
        name: child.name,
        type: childStat.isDirectory() ? 'folder' : 'file',
        size: childStat.isDirectory() ? null : childStat.size,
        modified: Number.isFinite(childStat.mtime.getTime()) ? childStat.mtime.toISOString() : null,
        ...(child.isSymbolicLink() ? { isSymbolicLink: true } : {}),
      };
    } catch {
      // Files may disappear or become inaccessible while the directory is read.
      skipped++;
      return null;
    }
  });
  return { ...locationDetails(directory), entries: entries.filter(Boolean), ...(skipped ? { skipped } : {}) };
}

function powershellDriveRoots() {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '[Environment]::GetLogicalDrives() | ConvertTo-Json -Compress'],
      { windowsHide: true, timeout: 5000, maxBuffer: 32768 }, (error, stdout) => {
        if (error) return reject(error);
        try {
          const parsed = JSON.parse(stdout.replace(/^\uFEFF/u, ''));
          const roots = (Array.isArray(parsed) ? parsed : [parsed]).filter(value => typeof value === 'string' && /^[a-z]:\\$/iu.test(value));
          if (!roots.length) throw new Error('No drive roots returned');
          resolve(roots);
        } catch (parseError) { reject(parseError); }
      });
  });
}

async function probeDriveRoots() {
  const roots = Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`);
  const available = await Promise.all(roots.map(async root => {
    let timer;
    try {
      return await Promise.race([
        fs.stat(root).then(stat => stat.isDirectory() ? root : null).catch(() => null),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), 1500); }),
      ]);
    } finally { clearTimeout(timer); }
  }));
  return available.filter(Boolean);
}

async function discoverDrives() {
  const roots = await powershellDriveRoots().catch(probeDriveRoots);
  return [...new Set(roots.map(normalizePath))].sort().map(root => ({ path: root, label: root.slice(0, 2) }));
}

function getFavorites(getPath) {
  return [
    ['home', '홈', 'home'],
    ['desktop', '바탕 화면', 'desktop'],
    ['downloads', '다운로드', 'download'],
    ['documents', '문서', 'documents'],
    ['pictures', '사진', 'image'],
  ].flatMap(([id, label, icon]) => {
    try { return [{ id, label, path: normalizePath(getPath(id)), icon }]; }
    catch { return []; }
  });
}

function errorResult(error) {
  const messages = {
    INVALID_PATH: '올바른 전체 폴더 경로를 입력해 주세요. 예: C:\\Users 또는 \\\\서버\\공유',
    ENOENT: '폴더를 찾을 수 없습니다. 경로와 드라이브 연결 상태를 확인해 주세요.',
    EACCES: '이 폴더에 접근할 권한이 없습니다.',
    EPERM: '이 폴더에 접근할 권한이 없습니다.',
    ENOTDIR: '폴더 경로를 입력해 주세요.',
    EBUSY: '드라이브를 현재 사용할 수 없습니다. 잠시 후 새로 고침해 주세요.',
    ENODEV: '드라이브를 사용할 수 없습니다. 연결 상태를 확인해 주세요.',
    ENXIO: '드라이브를 사용할 수 없습니다. 연결 상태를 확인해 주세요.',
    EIO: '드라이브를 읽을 수 없습니다. 연결 상태를 확인해 주세요.',
    ENETUNREACH: '네트워크 폴더에 연결할 수 없습니다.',
    EHOSTUNREACH: '네트워크 폴더에 연결할 수 없습니다.',
    ETIMEDOUT: '폴더 연결 시간이 초과되었습니다. 연결 상태를 확인해 주세요.',
    INVALID_SESSION: '작업 공간 설정 형식이 올바르지 않습니다.',
    SESSION_WRITE_FAILED: '열어 둔 폴더를 저장하지 못했습니다. 설정 폴더의 쓰기 권한과 남은 공간을 확인해 주세요.',
    FORBIDDEN: '허용되지 않은 화면의 요청입니다.',
  };
  const code = Object.hasOwn(messages, error?.code) ? error.code : 'READ_FAILED';
  return { ok: false, error: { code, message: messages[code] || '폴더를 읽지 못했습니다. 경로와 드라이브 연결 상태를 확인해 주세요.' } };
}

module.exports = { normalizePath, locationDetails, listDirectory, discoverDrives, getFavorites, errorResult };
