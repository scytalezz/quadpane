'use strict';
// Execute the real main wiring with Electron and the helper mocked. No native
// window, clipboard, file mutation or child process is created by these tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { createMutationCoordinator, validatePaths } = require('./explorer-actions.cjs');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const preventable = () => ({ prevented: false, preventDefault() { this.prevented = true; } });

async function harness({ close = () => undefined, transfer = async request => request,
  cancelResult = () => undefined,
  isPackaged = false, platform = 'win32', smokeTest = true, env = {}, updateClose = () => undefined,
  verifyReady = async () => 'D:\\portable\\quadpane-0.10.0-portable-x64.exe' } = {}) {
  const handlers = new Map(), requests = [], lifecycle = [];
  const taskbarOptions = [];
  let updateOptions;
  const updateCalls = [], sent = [], timers = [];
  const updateService = {
    getState: () => ({ currentVersion: '0.9.0', status: updateOptions.enabled ? 'idle' : 'unsupported' }),
    async check() { updateCalls.push('check'); return this.getState(); },
    async download() { updateCalls.push('download'); return this.getState(); },
    async verifyReady() { updateCalls.push('verify'); return verifyReady(); },
    close() { updateCalls.push('close'); return updateClose(); },
  };
  const mutations = createMutationCoordinator();
  let active, window;
  const cancel = () => {
    active?.reject(Object.assign(new Error('Cancelled by main'), { code: 'SHELL_CANCELLED' }));
    active = undefined;
  };
  const shellMenus = {
    start() { lifecycle.push('start'); },
    get pending() { return Boolean(active); },
    show(request, host, mode) {
      assert.equal(active, undefined, 'Main must not dispatch overlapping native requests in this fixture');
      active = deferred();
      requests.push({ request, host, mode });
      return active.promise;
    },
    cancel() { lifecycle.push('cancel'); cancel(); return cancelResult(); },
    close() { lifecycle.push('close'); cancel(); return close(); },
  };
  const app = Object.assign(new EventEmitter(), {
    isPackaged, commandLine: { hasSwitch: name => name === 'pane-smoke-test' && smokeTest },
    setPath() {}, enableSandbox() {}, setAppUserModelId() {}, getVersion: () => '0.9.0',
    relaunches: [], relaunch(options) { this.relaunches.push(options); },
    requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(),
    quitCalls: 0, quit() { this.quitCalls++; },
  });
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); window = this;
      this.options = options;
      lifecycle.push('window');
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: pathToFileURL(path.join(__dirname, '..', 'index.html')).href },
        setWindowOpenHandler() {}, isDestroyed: () => false,
        send: (...args) => sent.push(args),
        session: Object.assign(new EventEmitter(), { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }),
      });
    }
    setMenu() {}
    setAppDetails(details) { this.appDetails = details; lifecycle.push('app-details'); }
    show() { lifecycle.push('show'); }
    setTitle() {}
    isDestroyed() { return false; }
    async loadFile() {}
  }
  const mocks = {
    electron: { app, BrowserWindow, ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      dialog: { showErrorBox: message => assert.fail(message) }, Menu: { setApplicationMenu() {} }, nativeTheme: {}, shell: {}, screen: {} },
    'node:fs': { mkdirSync() {}, openSync: () => 1, closeSync() {}, unlinkSync() {} },
    './filesystem.cjs': { errorResult: error => ({ ok: false, error }),
      listDirectory(directory, options) { return { directory, accurate: options.accurate }; },
      closeDirectoryReader() { lifecycle.push('close-reader'); } },
    './session-store.cjs': { createSessionStore: () => ({}) },
    './preferences-store.cjs': { createPreferencesStore: () => ({}) },
    './file-operations.cjs': { createTransferService: () => ({ transfer }), transferError: error => error },
    './explorer-actions.cjs': { createMutationCoordinator: () => mutations, createExplorerActions: () => ({}), validatePaths, actionError: error => error },
    './shell-menu.cjs': { createShellMenuService: () => shellMenus },
    './taskbar.cjs': { createTaskbarIntegration(options) {
      taskbarOptions.push(options);
      if (!options.isPackaged || options.platform !== 'win32') return null;
      return { windowIcon: 'D:\\portable\\quadpane-data\\taskbar\\quadpane.ico',
        apply(target) { target.setAppDetails({ appId: options.applicationId }); } };
    } },
    './update-service.cjs': { createUpdateService(options) { updateOptions = options; return updateService; } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8'), {
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : require(name),
    __dirname, setImmediate, clearTimeout,
    setTimeout(callback, delay) { timers.push({ callback, delay }); return { unref() {} }; },
    process: { env, pid: 123, platform, arch: 'x64', execPath: process.execPath, resourcesPath: 'C:\\extracted\\resources' },
  }, { filename: 'main.cjs' });
  await tick();
  const invoke = (channel, ...args) => handlers.get(channel)({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, ...args);
  return { app, window, invoke, mutations, requests, lifecycle, taskbarOptions, updateOptions, updateCalls, sent, handlers, timers };
}

test('directory IPC forwards only explicit accurate mode', async () => {
  const fixture = await harness();
  for (const [options, expected] of [[undefined, false], [{ accurate: true }, true], [{ accurate: 'true' }, false], [null, false]]) {
    const result = await fixture.invoke('pane:list-directory', 'C:\\fixture', options);
    assert.equal(result.ok, true);
    assert.equal(result.value.directory, 'C:\\fixture');
    assert.equal(result.value.accurate, expected);
  }
});

test('cancel IPC acknowledges actual helper exit and reports failed cleanup', async () => {
  const exit = deferred();
  const f = await harness({ cancelResult: () => exit.promise });
  let settled = false;
  const cancellation = f.invoke('pane:cancel-shell').then(value => { settled = true; return value; });
  await tick();
  assert.equal(settled, false);
  exit.resolve([{ exited: true }]);
  assert.equal((await cancellation).ok, true);
  const failed = await harness({ cancelResult: async () => [{ exited: false }] });
  const result = await failed.invoke('pane:cancel-shell');
  assert.equal(result.error.code, 'SHELL_RECOVERY_FAILED');
  assert.match(result.error.message, /종료를 확인하지 못해/);
});

test('update IPC publishes the app version, isolates events and rejects untrusted senders', async () => {
  const f = await harness();
  assert.equal((await f.invoke('pane:update-state')).value.currentVersion, '0.9.0');
  const state = { currentVersion: '0.9.0', status: 'available' };
  f.updateOptions.onChange(state);
  assert.equal(f.sent[0][0], 'pane:update-state-changed');
  assert.equal(f.sent[0][1], state);
  for (const channel of ['pane:update-state', 'pane:update-check', 'pane:update-download', 'pane:update-install']) {
    for (const event of [
      { sender: {}, senderFrame: f.window.webContents.mainFrame },
      { sender: f.window.webContents, senderFrame: { url: f.window.webContents.mainFrame.url } },
    ]) assert.equal((await f.handlers.get(channel)(event)).error.code, 'FORBIDDEN');
  }
  assert.deepEqual(f.updateCalls, []);
});

test('only packaged portable startup schedules a delayed check, and smoke runs stay offline', async () => {
  const env = { PORTABLE_EXECUTABLE_DIR: 'D:\\portable', PORTABLE_EXECUTABLE_FILE: 'D:\\portable\\Quadpane.exe' };
  const f = await harness({ isPackaged: true, smokeTest: false, env });
  assert.equal(f.updateOptions.enabled, true);
  assert.equal(f.timers.length, 1);
  assert.equal(f.timers[0].delay, 10000);
  assert.deepEqual(f.updateCalls, []);
  f.timers[0].callback(); await tick();
  assert.deepEqual(f.updateCalls, ['check']);
  for (const options of [{}, { isPackaged: true }, { isPackaged: true, env, smokeTest: true }]) {
    const isolated = await harness(options);
    assert.equal(isolated.timers.length, 0);
  }
  f.app.emit('will-quit'); await tick();
  assert.ok(f.updateCalls.includes('close'));
});

test('update waits for file operations and native shell work before allowing restart', async () => {
  const moving = deferred();
  const f = await harness({ transfer: () => moving.promise });
  const transfer = f.invoke('pane:transfer', {});
  assert.equal((await f.invoke('pane:update-install')).error.code, 'UPDATE_BUSY');
  moving.resolve({}); await transfer;
  const drag = f.invoke('pane:begin-native-drag', ['C:\\fixture\\file.txt']);
  assert.equal((await f.invoke('pane:update-install')).error.code, 'UPDATE_BUSY');
  await f.invoke('pane:cancel-shell'); await drag;
  assert.deepEqual(f.updateCalls, []);
  assert.equal(f.app.relaunches.length, 0);
});

test('restart verifies its internal target once, prevents new work, and preserves graceful quit', async () => {
  const verification = deferred();
  const f = await harness({ verifyReady: () => verification.promise });
  const installing = f.invoke('pane:update-install', { path: 'C:\\untrusted.exe' });
  assert.equal((await f.invoke('pane:update-install')).error.code, 'UPDATE_BUSY');
  assert.equal((await f.invoke('pane:transfer', {})).error.code, 'ACTION_BUSY');
  assert.equal((await f.invoke('pane:read-shell-clipboard')).error.code, 'ACTION_BUSY');
  assert.equal(f.app.relaunches.length, 0);
  verification.resolve('D:\\portable\\verified.exe');
  assert.equal((await installing).ok, true);
  assert.equal(f.app.relaunches[0].execPath, 'D:\\portable\\verified.exe');
  assert.equal(f.app.relaunches[0].args.length, 0);
  await tick();
  assert.equal(f.app.quitCalls, 1);
  assert.deepEqual(f.updateCalls, ['verify']);
});

test('failed verification leaves the current app usable and permits retry', async () => {
  let attempts = 0;
  const f = await harness({ verifyReady: async () => {
    if (++attempts === 1) throw Object.assign(new Error('파일 검증 실패'), { code: 'UPDATE_INTEGRITY' });
    return 'D:\\portable\\verified.exe';
  } });
  assert.equal((await f.invoke('pane:update-install')).error.code, 'UPDATE_INTEGRITY');
  assert.equal(f.app.relaunches.length, 0);
  assert.equal((await f.invoke('pane:transfer', {})).ok, true);
  assert.equal((await f.invoke('pane:update-install')).ok, true);
  await tick();
  assert.equal(f.app.relaunches.length, 1);
});

test('quit waits for partial update cleanup as well as shell shutdown', async () => {
  const cleanup = deferred();
  const f = await harness({ updateClose: () => cleanup.promise });
  const event = preventable();
  f.app.emit('before-quit', event); await tick();
  assert.equal(event.prevented, true);
  assert.equal(f.app.quitCalls, 0);
  cleanup.resolve(); await tick();
  assert.equal(f.app.quitCalls, 1);
  const final = preventable(); f.app.emit('before-quit', final);
  assert.equal(final.prevented, false);
});

test('packaged Windows applies persistent taskbar details before first show', async () => {
  const env = { PORTABLE_EXECUTABLE_DIR: 'D:\\portable', PORTABLE_EXECUTABLE_FILE: 'D:\\portable\\Quadpane.exe' };
  const fixture = await harness({ isPackaged: true, smokeTest: false, env });
  assert.equal(fixture.window.options.icon, 'D:\\portable\\quadpane-data\\taskbar\\quadpane.ico');
  assert.equal(fixture.window.appDetails.appId, 'com.quadpane.app');
  fixture.window.emit('ready-to-show');
  assert.ok(fixture.lifecycle.indexOf('app-details') < fixture.lifecycle.indexOf('show'));
  const options = fixture.taskbarOptions[0];
  assert.equal(options.env, env);
  assert.equal(options.portableDirectory, env.PORTABLE_EXECUTABLE_DIR);
  assert.equal(options.dataDirectory, path.join(env.PORTABLE_EXECUTABLE_DIR, 'quadpane-data'));
  assert.equal(options.iconSource, path.join(__dirname, 'quadpane.ico'));
  assert.equal(options.execPath, process.execPath);
  assert.equal(options.smokeTest, false);
});

test('smoke startup passes pin-repair suppression and keeps the window hidden', async () => {
  const fixture = await harness({ isPackaged: true });
  assert.equal(fixture.taskbarOptions[0].smokeTest, true);
  fixture.window.emit('ready-to-show');
  assert.ok(fixture.lifecycle.includes('app-details'));
  assert.ok(!fixture.lifecycle.includes('show'));
});

for (const options of [{ isPackaged: false }, { isPackaged: true, platform: 'linux' }]) {
  test(`taskbar integration leaves development/non-Windows window behavior unchanged: ${JSON.stringify(options)}`, async () => {
    const fixture = await harness(options);
    assert.equal(fixture.window.options.icon, path.join(__dirname, 'quadpane.ico'));
    assert.equal(fixture.window.appDetails, undefined);
  });
}

test('native drag leaves mutation lane free for an in-app drop and cancellation recovers', async () => {
  const fixture = await harness();
  const drag = fixture.invoke('pane:begin-native-drag', ['C:\\source\\file.txt']);
  assert.equal(fixture.requests[0].mode, 'drag');
  assert.equal(fixture.mutations.pending, undefined);
  const transfer = await fixture.invoke('pane:transfer', { sources: ['C:\\source\\file.txt'], destination: 'C:\\target', operation: 'move' });
  assert.equal(transfer.ok, true, 'Transfer completes before native IPC is settled');
  assert.equal((await fixture.invoke('pane:cancel-shell')).ok, true);
  assert.equal((await drag).error.code, 'SHELL_CANCELLED');
  const retry = fixture.invoke('pane:begin-native-drag', ['C:\\source\\other.txt']);
  assert.equal(fixture.requests.length, 2);
  await fixture.invoke('pane:cancel-shell');
  assert.equal((await retry).error.code, 'SHELL_CANCELLED');
});

for (const event of ['render-process-gone', 'destroyed', 'closed']) {
  test(`${event} retires an abandoned native drag without a normal close event`, async () => {
    const fixture = await harness();
    const drag = fixture.invoke('pane:begin-native-drag', ['C:\\source\\file.txt']);
    (event === 'closed' ? fixture.window : fixture.window.webContents).emit(event);
    assert.equal((await drag).error.code, 'SHELL_CANCELLED');
    assert.ok(fixture.lifecycle.includes(event === 'closed' ? 'close' : 'cancel'));
  });
}

test('quit waits for graceful shell close once, including prior renderer destruction', async () => {
  const closing = deferred();
  const fixture = await harness({ close: () => closing.promise });
  fixture.window.webContents.emit('destroyed');
  fixture.window.emit('closed');
  const first = preventable(), repeated = preventable();
  fixture.app.emit('before-quit', first);
  fixture.app.emit('before-quit', repeated);
  await tick();
  assert.equal(first.prevented, true);
  assert.equal(repeated.prevented, true);
  assert.equal(fixture.lifecycle.filter(event => event === 'close').length, 1);
  assert.equal(fixture.lifecycle.includes('cancel'), false, 'Idle helper gets EOF to flush clipboard');
  assert.equal(fixture.app.quitCalls, 0);
  closing.resolve(); await tick();
  assert.equal(fixture.app.quitCalls, 1);
  const final = preventable(); fixture.app.emit('before-quit', final); fixture.app.emit('will-quit');
  await tick();
  assert.equal(final.prevented, false, 'The final app.quit is allowed through');
  assert.equal(fixture.lifecycle.filter(event => event === 'close').length, 1);
  assert.equal(fixture.lifecycle.filter(event => event === 'close-reader').length, 1);
});

for (const trigger of ['before-quit', 'close']) {
  test(`${trigger} cancels native drag, waits for transfer, then waits for shell cleanup`, async () => {
    const moving = deferred(), closing = deferred();
    const fixture = await harness({ transfer: () => moving.promise, close: () => closing.promise });
    const drag = fixture.invoke('pane:begin-native-drag', ['C:\\source\\file.txt']);
    const transfer = fixture.invoke('pane:transfer', {});
    const event = preventable();
    (trigger === 'before-quit' ? fixture.app : fixture.window).emit(trigger, event);
    assert.equal(event.prevented, true);
    assert.equal((await drag).error.code, 'SHELL_CANCELLED');
    assert.equal(fixture.app.quitCalls, 0);
    assert.equal(fixture.lifecycle.includes('close'), false);
    moving.resolve({ completed: [] }); await transfer; await tick();
    assert.equal(fixture.app.quitCalls, 1);
    const retry = preventable(); fixture.app.emit('before-quit', retry); await tick();
    assert.equal(retry.prevented, true);
    assert.equal(fixture.lifecycle.filter(event => event === 'close').length, 1);
    assert.equal(fixture.app.quitCalls, 1);
    closing.resolve(); await tick();
    assert.equal(fixture.app.quitCalls, 2);
  });
}

test('a transfer started during graceful shutdown still blocks the final quit', async () => {
  const moving = deferred(), closing = deferred();
  const fixture = await harness({ transfer: () => moving.promise, close: () => closing.promise });
  fixture.app.emit('before-quit', preventable()); await tick();
  const transfer = fixture.invoke('pane:transfer', {});
  closing.resolve(); await tick();
  const retry = preventable(); fixture.app.emit('before-quit', retry);
  assert.equal(retry.prevented, true);
  moving.resolve({ completed: [] }); await transfer; await tick();
  const final = preventable(); fixture.app.emit('before-quit', final);
  assert.equal(final.prevented, false);
  assert.equal(fixture.lifecycle.filter(event => event === 'close').length, 1);
});

for (const [name, close] of [
  ['void', () => undefined],
  ['rejected', () => Promise.reject(new Error('Mock close failure'))],
  ['throwing', () => { throw new Error('Mock close failure'); }],
]) {
  test(`${name} shell close does not trap quit or produce an unhandled rejection`, async () => {
    const fixture = await harness({ close });
    fixture.app.emit('before-quit', preventable()); await tick();
    assert.equal(fixture.app.quitCalls, 1);
    const final = preventable(); fixture.app.emit('before-quit', final);
    assert.equal(final.prevented, false);
  });
}
