'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { mutationPath } = require('./file-operations.cjs');
const { validatePaths } = require('./explorer-actions.cjs');

async function validateMenuRequest(request) {
  if (!request || !Array.isArray(request.paths) || request.paths.length > 1000) throw new Error('Invalid shell selection');
  const parent = mutationPath(request.parent);
  const paths = request.paths.length ? validatePaths(request.paths) : [];
  if (!(await fs.stat(parent)).isDirectory()) throw new Error('Shell menu requires a folder');
  for (const filename of paths) {
    if (path.win32.dirname(filename).toLowerCase() !== parent.toLowerCase()) throw new Error('Shell selection must share its parent');
    await fs.lstat(filename);
  }
  return { parent, paths, extended: request.extended === true };
}

function createShellMenuService(executable, options = {}) {
  let child, pending, sequence = 0;
  const queue = [];
  const clipboardModes = new Set(['readClipboard', 'writeClipboard', 'completePaste']);
  const failure = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });
  function rejectAll(error) {
    const items = pending ? [pending, ...queue] : [...queue];
    pending = undefined;
    queue.length = 0;
    for (const item of items) item.reject(error);
  }
  function retire(worker, error) {
    if (child !== worker) return;
    child = undefined;
    rejectAll(error);
    worker.kill();
  }
  function settle(error, value) {
    const item = pending;
    pending = undefined;
    if (error) item.reject(error);
    else item.resolve(value);
    drain();
  }
  function drain() {
    if (pending || !queue.length) return;
    const item = pending = queue.shift();
    const { request, host, mode, id } = item;
    const validation = ['readClipboard', 'completePaste'].includes(mode) ? Promise.resolve({}) : validateMenuRequest(request);
    validation.then(validated => {
      if (pending !== item) return;
      const payload = `${JSON.stringify({ ...validated, ...host, mode, id, operation: request?.operation })}\n`;
      try {
        start();
        child.stdin.write(payload);
      } catch (error) {
        if (child) retire(child, error);
        else rejectAll(error);
      }
    }).catch(error => { if (pending === item) settle(error); });
  }
  function start() {
    if (child) return;
    const worker = (options.spawn || spawn)(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child = worker;
    const lines = createInterface({ input: worker.stdout });
    lines.on('line', line => {
      if (child !== worker) return;
      try {
        const response = JSON.parse(line);
        if (!response || typeof response.id !== 'string' || typeof response.ok !== 'boolean') throw new Error('Invalid shell helper response');
        if (response.id !== pending?.id) return;
        if (response.ok) settle(null, response.value);
        else {
          const native = response.error;
          settle(failure(native?.code || response.code || 'SHELL_NATIVE_ERROR',
            typeof native === 'string' ? native : native?.message || 'Windows shell operation failed',
            { nativeError: native, ...(native?.hresult !== undefined ? { hresult: native.hresult } : {}) }));
        }
      } catch (error) { retire(worker, failure('SHELL_PROTOCOL_ERROR', error.message)); }
    });
    worker.stderr.resume();
    worker.stdin.on('error', error => retire(worker, error));
    worker.on('error', error => retire(worker, error));
    worker.on('exit', (exitCode, signal) => {
      lines.close();
      if (child === worker) {
        child = undefined;
        rejectAll(failure('SHELL_HELPER_EXITED', 'Windows shell helper exited', { exitCode, signal }));
      }
    });
  }
  return {
    start,
    async show(request, host, mode = 'show') {
      // Clipboard work is FIFO. Reserve one UI operation after that work, including
      // validation. Never queue anything behind UI: a native drag's nested loop
      // may need the renderer to finish an in-app drop before the drag can return.
      if ((pending && !clipboardModes.has(pending.mode)) || queue.some(item => !clipboardModes.has(item.mode))) {
        throw failure('SHELL_BUSY', 'A Windows shell menu or drag is already active');
      }
      const id = String(++sequence);
      return new Promise((resolve, reject) => {
        queue.push({ id, resolve, reject, request, host, mode });
        drain();
      });
    },
    get pending() { return Boolean(pending); },
    cancel() {
      const worker = child;
      child = undefined;
      rejectAll(failure('SHELL_CANCELLED', 'Windows shell operation cancelled'));
      worker?.kill();
    },
    close() {
      // EOF requests graceful OleFlushClipboard and message-loop shutdown.
      const worker = child;
      child = undefined;
      rejectAll(failure('SHELL_CANCELLED', 'Windows shell operation cancelled'));
      if (!worker) return;
      worker.stdin.end();
      const timer = setTimeout(() => worker.kill(), 3000);
      timer.unref();
      worker.once('exit', () => clearTimeout(timer));
    },
  };
}
module.exports = { createShellMenuService, validateMenuRequest };
