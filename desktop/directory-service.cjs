'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

function readerPath(runtime = process, directory = __dirname) {
  return runtime.resourcesPath && !runtime.defaultApp
    ? path.join(runtime.resourcesPath, 'native', 'Quadpane.Directory.exe')
    : path.join(directory, 'native', 'bin', 'Quadpane.Directory.exe');
}

function failure(code = 'DIRECTORY_READ_FAILED') {
  return Object.assign(new Error('폴더 정보를 읽지 못했습니다. 새로 고침해 주세요.'), { code });
}

function nativeError(code) {
  const codes = { 2: 'ENOENT', 3: 'ENOENT', 5: 'EACCES', 15: 'ENODEV', 21: 'ENODEV',
    32: 'EBUSY', 53: 'ENETUNREACH', 64: 'ENETUNREACH', 67: 'ENOENT', 121: 'ETIMEDOUT',
    123: 'INVALID_PATH', 161: 'INVALID_PATH', 206: 'INVALID_PATH', 267: 'ENOTDIR',
    995: 'EIO', 1117: 'EIO', 1231: 'ENETUNREACH', 1232: 'EHOSTUNREACH', 1460: 'ETIMEDOUT' };
  return failure(codes[code] || 'DIRECTORY_READ_FAILED');
}

function validEntry(entry) {
  return entry && typeof entry.name === 'string' && entry.name.length > 0
    && !/[\\/:\u0000-\u001f]/u.test(entry.name) && entry.name !== '.' && entry.name !== '..'
    && ['file', 'folder'].includes(entry.type) && typeof entry.hidden === 'boolean'
    && (entry.isSymbolicLink === undefined || entry.isSymbolicLink === true)
    && (entry.unavailable === undefined || entry.unavailable === true)
    && (entry.type === 'folder' ? entry.size === null : Number.isFinite(entry.size) && entry.size >= 0)
    && (entry.modified === null || (typeof entry.modified === 'string' && Number.isFinite(Date.parse(entry.modified))));
}

// One windowless worker is shared while browsing. Only requests are queued;
// completed listings are never cached, so refresh always observes new metadata.
function createDirectoryService({ executable = readerPath(), spawnProcess = spawn,
  timeoutMs = 15000, idleMs = 10000, maxResponseBytes = 64 * 1024 * 1024,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let worker, active, idleTimer, nextId = 0, closed = false;
  const queue = [];

  function retire() {
    clearTimer(idleTimer); idleTimer = undefined;
    const previous = worker;
    worker = undefined;
    if (!previous) return;
    previous.child.stdin.destroy();
    previous.child.stdout.destroy();
    previous.child.kill();
  }

  function rejectAll(error) {
    retire();
    if (active) {
      clearTimer(active.timer);
      active.reject(error);
      active = undefined;
    }
    for (const request of queue.splice(0)) request.reject(error);
  }

  function receive(state, data) {
    if (worker !== state) return;
    state.bytes += Buffer.byteLength(data, 'utf8');
    if (state.bytes > maxResponseBytes) return rejectAll(failure());
    const newline = data.indexOf('\n');
    if (newline === -1) { state.parts.push(data); return; }
    // Only one request is sent at a time. Avoid repeatedly scanning/copying a
    // growing JSON string when a large directory arrives in many pipe chunks.
    if (newline !== data.length - 1) return rejectAll(failure());
    state.parts.push(data.slice(0, newline));
    const line = state.parts.join('');
    state.parts = [];
    state.bytes = 0;
    let response;
    try { response = JSON.parse(line); } catch { return rejectAll(failure()); }
    if (!active || response?.id !== active.id
      || typeof response.ok !== 'boolean') return rejectAll(failure());
    if (response.ok ? !Array.isArray(response.entries) || !response.entries.every(validEntry)
      : !Number.isInteger(response.error?.win32Code)) return rejectAll(failure());
    const request = active;
    active = undefined;
    clearTimer(request.timer);
    if (response.ok) request.resolve(response.entries);
    else request.reject(nativeError(response.error.win32Code));
    dispatch();
  }

  function start() {
    const child = spawnProcess(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const state = { child, parts: [], bytes: 0 };
    worker = state;
    // Pending request timers keep Node alive; an idle worker does not hold up exit.
    child.unref();
    child.stdin.unref?.();
    child.stdout.unref?.();
    child.stdout.setEncoding('utf8');
    const stopped = () => { if (worker === state) rejectAll(failure()); };
    child.on('error', stopped);
    child.on('exit', stopped);
    child.stdin.on('error', stopped);
    child.stdout.on('error', stopped);
    child.stdout.on('end', stopped);
    child.stdout.on('data', data => receive(state, data));
  }

  function dispatch() {
    if (closed || active) return;
    clearTimer(idleTimer); idleTimer = undefined;
    if (!queue.length) {
      if (worker) {
        idleTimer = setTimer(retire, idleMs);
        idleTimer.unref?.();
      }
      return;
    }
    active = queue.shift();
    active.timer = setTimer(() => rejectAll(failure('ETIMEDOUT')), timeoutMs);
    try {
      if (!worker) start();
      worker.child.stdin.write(JSON.stringify({ id: active.id, path: path.win32.toNamespacedPath(active.directory), accurate: active.accurate }) + '\n', 'utf8');
    } catch { rejectAll(failure()); }
  }

  return {
    list(directory, options = {}) {
      if (closed) return Promise.reject(failure());
      return new Promise((resolve, reject) => {
        queue.push({ id: ++nextId, directory, accurate: options.accurate === true, resolve, reject });
        dispatch();
      });
    },
    close() { closed = true; rejectAll(failure()); },
  };
}

module.exports = { createDirectoryService, readerPath };
