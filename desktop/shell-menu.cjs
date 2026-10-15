'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { mutationPath } = require('./file-operations.cjs');
const { validatePaths } = require('./explorer-actions.cjs');

async function validateMenuRequest(request, { signal } = {}) {
  signal?.throwIfAborted();
  if (!request || !Array.isArray(request.paths) || request.paths.length > 1000) throw new Error('Invalid shell selection');
  const parent = mutationPath(request.parent);
  const paths = request.paths.length ? validatePaths(request.paths) : [];
  if (!(await fs.stat(parent)).isDirectory()) throw new Error('Shell menu requires a folder');
  for (const filename of paths) {
    signal?.throwIfAborted();
    if (path.win32.dirname(filename).toLowerCase() !== parent.toLowerCase()) throw new Error('Shell selection must share its parent');
    await fs.lstat(filename);
  }
  signal?.throwIfAborted();
  return { parent, paths, extended: request.extended === true };
}

const defaultTimeouts = Object.freeze({
  validationMs: 30000, workerMs: 30000, clipboardMs: 15000,
  shutdownMs: 3000,
});

function createShellMenuService(executable, options = {}) {
  let child, pending, sequence = 0, closed = false, closing;
  const queue = [];
  const workers = new Map();
  const lifecycle = options.lifecycle || process;
  const timers = options.timers || { setTimeout, clearTimeout };
  const timeouts = { ...defaultTimeouts, ...options.timeouts };
  for (const [name, value] of Object.entries(timeouts)) {
    if (!Number.isFinite(value) || value <= 0 || value > 2147483647) throw new RangeError(`Invalid shell timeout: ${name}`);
  }
  const clipboardModes = new Set(['readClipboard', 'writeClipboard', 'completePaste']);
  const failure = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });
  function clearDeadline(item) {
    timers.clearTimeout(item.timer);
    item.deadline = undefined;
  }
  function revoke(item) {
    clearDeadline(item);
    item.validation?.abort();
  }
  function rejectAll(error) {
    const items = pending ? [pending, ...queue] : [...queue];
    pending = undefined;
    queue.length = 0;
    for (const item of items) {
      revoke(item);
      // Queued requests were never sent; only the active dispatched operation
      // can have an uncertain outcome. Never replay either kind automatically.
      item.reject(error.code === 'SHELL_TIMEOUT' ? failure(error.code, error.message, {
        requestId: item.id, mode: item.mode, phase: item.phase || 'queued',
        timeoutMs: error.timeoutMs, outcomeUncertain: Boolean(item.worker), retryable: false,
      }) : error);
    }
  }
  function kill(worker) {
    // Target only the ChildProcess created here, never Explorer or a PID lookup.
    try { return worker.kill('SIGKILL') !== false; } catch { return false; }
  }
  function onProcessExit() {
    closed = true;
    child = undefined;
    rejectAll(failure('SHELL_CANCELLED', 'Windows shell operation cancelled'));
    // An exit callback cannot wait for timers or EOF handling on a blocked STA.
    for (const worker of workers.keys()) kill(worker);
  }
  function retire(worker, error) {
    if (child !== worker) return;
    child = undefined;
    rejectAll(error);
    workers.get(worker)?.lines.close();
    kill(worker);
  }
  function settle(error, value) {
    const item = pending;
    pending = undefined;
    revoke(item);
    if (error) item.reject(error);
    else item.resolve(value);
    drain();
  }
  function arm(item, phase, timeoutMs) {
    clearDeadline(item);
    const deadline = item.deadline = {};
    item.phase = phase;
    item.timer = timers.setTimeout(() => {
      // clearTimeout alone is insufficient if its callback was already queued.
      if (pending !== item || item.deadline !== deadline) return;
      const error = failure('SHELL_TIMEOUT', `Windows shell ${phase} exceeded ${timeoutMs}ms`, { timeoutMs });
      if (child) retire(child, error);
      else rejectAll(error);
    }, timeoutMs);
  }
  function progress(item, phase) {
    if (!['show', 'drag'].includes(item.mode) || !['interactive', 'committing'].includes(phase)) {
      throw new Error('Invalid shell helper phase');
    }
    // Waiting for a user's choice and executing an external Drop/InvokeCommand
    // have no safe absolute deadline. The native drag watchdog must distinguish
    // lost mouse-up from a real drop. Explicit cancellation/close still revokes
    // these phases. A late preparation callback cannot kill a committing worker.
    if (item.phase === 'committing') return;
    clearDeadline(item);
    item.phase = phase;
  }
  function drain() {
    if (closed || pending || !queue.length) return;
    const item = pending = queue.shift();
    const { request, host, mode, id } = item;
    item.validation = new AbortController();
    arm(item, 'validation', timeouts.validationMs);
    Promise.resolve().then(() => {
      if (pending !== item) return;
      return ['readClipboard', 'completePaste'].includes(mode) ? {} :
        (options.validate || validateMenuRequest)(request, { signal: item.validation.signal });
    }).then(validated => {
      if (pending !== item) return;
      try {
        const payload = `${JSON.stringify({ ...validated, ...host, mode, id, operation: request?.operation, reportProgress: true })}\n`;
        start();
        const worker = item.worker = child;
        arm(item, clipboardModes.has(mode) ? 'clipboard' : 'worker', clipboardModes.has(mode) ? timeouts.clipboardMs : timeouts.workerMs);
        worker.stdin.write(payload, error => { if (error && child === worker && pending === item) retire(worker, error); });
      } catch (error) {
        if (child) retire(child, error);
        else rejectAll(error);
      }
    }).catch(error => { if (pending === item) settle(error); });
  }
  function start() {
    if (closed) throw failure('SHELL_CLOSED', 'Windows shell service closed');
    if (child) return;
    const worker = (options.spawn || spawn)(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child = worker;
    const lines = createInterface({ input: worker.stdout });
    if (!workers.size) lifecycle.once('exit', onProcessExit);
    workers.set(worker, { lines });
    lines.on('line', line => {
      if (child !== worker) return;
      try {
        const response = JSON.parse(line);
        if (!response || typeof response.id !== 'string') throw new Error('Invalid shell helper response');
        if (response.id !== pending?.id || pending.worker !== worker) return;
        if (response.phase !== undefined && response.ok === undefined) return progress(pending, response.phase);
        if (typeof response.ok !== 'boolean') throw new Error('Invalid shell helper response');
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
    worker.stdout.on('error', error => retire(worker, error));
    worker.stderr.on('error', error => retire(worker, error));
    worker.on('error', error => retire(worker, error));
    function exited(exitCode, signal) {
      if (!workers.has(worker)) return;
      lines.close();
      workers.delete(worker);
      if (!workers.size) lifecycle.removeListener('exit', onProcessExit);
      if (child === worker) {
        child = undefined;
        rejectAll(failure('SHELL_HELPER_EXITED', 'Windows shell helper exited', { exitCode, signal }));
      }
    }
    worker.once('exit', exited);
    worker.once('close', exited); // Failed spawn can emit close without exit.
  }
  return {
    start,
    async show(request, host, mode = 'show') {
      if (closed) throw failure('SHELL_CLOSED', 'Windows shell service closed');
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
      if (worker) workers.get(worker)?.lines.close();
      // Retry termination of any retired helper that has not emitted exit yet.
      for (const owned of workers.keys()) kill(owned);
    },
    close() {
      if (closing) return closing;
      closed = true;
      const active = Boolean(pending);
      const worker = child;
      child = undefined;
      rejectAll(failure('SHELL_CANCELLED', 'Windows shell operation cancelled'));
      // Callers can await graceful clipboard flushing. Keep the fallback timer
      // referenced, and keep owned workers in the exit hook until actual exit.
      // A pending UI/COM call cannot reliably process EOF: kill it immediately.
      closing = Promise.all([...workers.keys()].map(owned => new Promise(resolve => {
        let finished = false, timer;
        const finish = exited => {
          if (finished) return;
          finished = true;
          timers.clearTimeout(timer);
          owned.removeListener('exit', exitedHandler);
          owned.removeListener('close', exitedHandler);
          resolve({ exited });
        };
        const exitedHandler = () => finish(true);
        owned.once('exit', exitedHandler);
        owned.once('close', exitedHandler);
        timer = timers.setTimeout(() => {
          if (finished) return;
          kill(owned);
          finish(false);
        }, timeouts.shutdownMs);
        if (active || owned !== worker) kill(owned);
        else {
          try { owned.stdin.end(); } catch { kill(owned); }
        }
      })));
      return closing;
    },
  };
}
module.exports = { createShellMenuService, validateMenuRequest, defaultTimeouts };
