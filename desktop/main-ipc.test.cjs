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

async function harness({ close = () => undefined, transfer = async request => request } = {}) {
  const handlers = new Map(), requests = [], lifecycle = [];
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
    cancel() { lifecycle.push('cancel'); cancel(); },
    close() { lifecycle.push('close'); cancel(); return close(); },
  };
  const app = Object.assign(new EventEmitter(), {
    isPackaged: false, commandLine: { hasSwitch: () => true },
    setPath() {}, enableSandbox() {}, setAppUserModelId() {},
    requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(),
    quitCalls: 0, quit() { this.quitCalls++; },
  });
  class BrowserWindow extends EventEmitter {
    constructor() {
      super(); window = this;
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: pathToFileURL(path.join(__dirname, '..', 'index.html')).href },
        setWindowOpenHandler() {}, isDestroyed: () => false,
        session: Object.assign(new EventEmitter(), { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }),
      });
    }
    setMenu() {}
    setTitle() {}
    isDestroyed() { return false; }
    async loadFile() {}
  }
  const mocks = {
    electron: { app, BrowserWindow, ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      dialog: { showErrorBox: message => assert.fail(message) }, Menu: { setApplicationMenu() {} }, nativeTheme: {}, shell: {}, screen: {} },
    'node:fs': { mkdirSync() {}, openSync: () => 1, closeSync() {}, unlinkSync() {} },
    './filesystem.cjs': { errorResult: error => ({ ok: false, error }) },
    './session-store.cjs': { createSessionStore: () => ({}) },
    './preferences-store.cjs': { createPreferencesStore: () => ({}) },
    './file-operations.cjs': { createTransferService: () => ({ transfer }), transferError: error => error },
    './explorer-actions.cjs': { createMutationCoordinator: () => mutations, createExplorerActions: () => ({}), validatePaths, actionError: error => error },
    './shell-menu.cjs': { createShellMenuService: () => shellMenus },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8'), {
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : require(name),
    __dirname, process: { env: {}, pid: 123, execPath: process.execPath },
  }, { filename: 'main.cjs' });
  await tick();
  const invoke = (channel, ...args) => handlers.get(channel)({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, ...args);
  return { app, window, invoke, mutations, requests, lifecycle };
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
