'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// Exercise the actual window setup without opening Electron or writing profile data.
function mainWindowForTest() {
  let window;
  const sent = [];
  const browserBack = () => assert.fail('Mouse Back must not navigate browser history');
  class BrowserWindow extends EventEmitter {
    constructor() {
      super();
      window = this;
      this.destroyed = false;
      this.webContents = Object.assign(new EventEmitter(), {
        destroyed: false,
        isDestroyed() { return this.destroyed; },
        send: (...args) => sent.push(args),
        canGoBack: () => true,
        goBack: browserBack,
        navigationHistory: { canGoBack: () => true, goBack: browserBack },
        setWindowOpenHandler() {},
        session: Object.assign(new EventEmitter(), {
          setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
        }),
      });
    }
    isDestroyed() { return this.destroyed; }
    setMenu() {}
    loadFile() { return Promise.resolve(); }
  }
  const app = { isPackaged: false, setPath() {}, exit() {}, enableSandbox() {}, setAppUserModelId() {},
    requestSingleInstanceLock: () => false, quit() {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8') + '\ncreateWindow();', {
    __dirname, process, console, Buffer,
    require(name) {
      if (name === 'electron') return { app, BrowserWindow, nativeTheme: { shouldUseDarkColors: false } };
      if (name === 'node:fs') return { mkdirSync() {}, openSync() {}, closeSync() {}, unlinkSync() {} };
      if (name === './shell-menu.cjs') return { createShellMenuService: () => ({}) };
      if (name === './session-store.cjs') return { createSessionStore: () => ({}) };
      if (name === './preferences-store.cjs') return { createPreferencesStore: () => ({}) };
      return require(name);
    },
  }, { filename: 'main.cjs' });
  return { window, sent };
}

function preloadForTest() {
  let pane;
  const ipcRenderer = new EventEmitter();
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8'), {
    require(name) {
      assert.equal(name, 'electron');
      return {
        ipcRenderer,
        contextBridge: { exposeInMainWorld(name, api) { assert.equal(name, 'pane'); pane = api; } },
      };
    },
  }, { filename: 'preload.cjs' });
  return { pane, ipcRenderer };
}

test('actual main window sends one payload-free pane navigation event for each Mouse Back', () => {
  const { window, sent } = mainWindowForTest();
  window.emit('app-command', { sender: window.webContents }, 'browser-backward');
  assert.deepEqual(sent, [['pane:navigate-back']]);
  window.emit('app-command', {}, 'browser-backward');
  assert.deepEqual(sent, [['pane:navigate-back'], ['pane:navigate-back']]);
});

test('actual main window ignores forward, media, and other app commands', () => {
  const { window, sent } = mainWindowForTest();
  for (const command of ['browser-forward', 'browser-refresh', 'media-play-pause', 'volume-up',
    'APPCOMMAND_BROWSER_BACKWARD', 'browser-back', '', undefined]) {
    window.emit('app-command', {}, command);
  }
  assert.deepEqual(sent, []);
});

test('actual main window ignores Mouse Back after window or webContents destruction or closure', () => {
  for (const state of ['window-destroyed', 'contents-destroyed', 'closed']) {
    const { window, sent } = mainWindowForTest();
    // First verify this fixture has a working navigation route.
    window.emit('app-command', {}, 'browser-backward');
    assert.deepEqual(sent, [['pane:navigate-back']], state);
    sent.length = 0;
    if (state === 'window-destroyed') window.destroyed = true;
    if (state === 'contents-destroyed') window.webContents.destroyed = true;
    if (state === 'closed') window.emit('closed');
    assert.doesNotThrow(() => window.emit('app-command', {}, 'browser-backward'), state);
    assert.deepEqual(sent, [], state);
  }
});

test('actual preload subscribes only to navigation back and hides the Electron event and all arguments', () => {
  const { pane, ipcRenderer } = preloadForTest();
  const calls = [];
  pane.onNavigateBack(function (...args) { calls.push({ args, receiver: this }); });
  ipcRenderer.emit('pane:navigate-forward', { sender: ipcRenderer });
  assert.deepEqual(calls, []);
  ipcRenderer.emit('pane:navigate-back', { sender: ipcRenderer }, 'untrusted payload', { path: 'C:\\' });
  assert.deepEqual(calls, [{ args: [], receiver: undefined }]);
});

test('actual preload unsubscribe removes only its subscription and can be called twice', () => {
  const { pane, ipcRenderer } = preloadForTest();
  let calls = 0;
  const callback = () => { calls += 1; };
  const unsubscribe = pane.onNavigateBack(callback);
  const unsubscribeOther = pane.onNavigateBack(callback);
  assert.equal(typeof unsubscribe, 'function');
  ipcRenderer.emit('pane:navigate-back', {});
  assert.equal(calls, 2);
  unsubscribe();
  unsubscribe();
  assert.equal(ipcRenderer.listenerCount('pane:navigate-back'), 1);
  ipcRenderer.emit('pane:navigate-back', {});
  assert.equal(calls, 3);
  unsubscribeOther();
  assert.equal(ipcRenderer.listenerCount('pane:navigate-back'), 0);
  ipcRenderer.emit('pane:navigate-back', {});
  assert.equal(calls, 3);
});

test('actual preload rejects invalid callbacks before registering any listener', () => {
  const { pane, ipcRenderer } = preloadForTest();
  assert.equal(typeof pane.onNavigateBack, 'function');
  for (const callback of [undefined, null, false, 42, 'pane:navigate-back', {}, []]) {
    assert.throws(() => pane.onNavigateBack(callback), { name: 'TypeError' });
  }
  assert.equal(ipcRenderer.listenerCount('pane:navigate-back'), 0);
});
