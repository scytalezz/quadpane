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
  const browserNavigation = () => assert.fail('Mouse Back/Forward must not navigate browser history');
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
        canGoForward: () => true,
        goBack: browserNavigation,
        goForward: browserNavigation,
        navigationHistory: {
          canGoBack: () => true, canGoForward: () => true,
          goBack: browserNavigation, goForward: browserNavigation,
        },
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
  const createWindow = vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8') + '\ncreateWindow;', {
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
  createWindow();
  return { window, sent, createWindow: () => { createWindow(); return window; } };
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

function emitMouse(window, input) {
  const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  window.webContents.emit('before-mouse-event', event, Object.freeze(input), 'untrusted payload');
  return event;
}

test('actual main window leaves unrelated mouse buttons and event types unchanged', () => {
  const { window, sent } = mainWindowForTest();
  const types = ['mouseDown', 'mouseUp', 'mouseMove', 'mouseEnter', 'mouseLeave', 'mouseWheel', 'rawKeyDown'];
  for (const button of ['left', 'middle', 'right', 'none', 'back', 'forward', 'Back', 'forward ', 3, 4, undefined]) {
    for (const type of types) {
      if (['back', 'forward'].includes(button) && ['mouseDown', 'mouseUp'].includes(type)) continue;
      const input = { type, button, x: 10, y: 20, clickCount: 1 };
      const original = { ...input };
      assert.equal(emitMouse(window, input).defaultPrevented, false, `${button}/${type}`);
      assert.deepEqual(input, original);
      assert.deepEqual(sent, []);
    }
  }
});

test('actual main window delivers every rapid side-button pair without losing repeated directions', () => {
  const { window, sent } = mainWindowForTest();
  const expected = [];
  for (let cycle = 0; cycle < 20; cycle += 1) {
    for (const button of ['back', 'back', 'forward', 'forward', 'back', 'forward']) {
      emitMouse(window, { type: 'mouseDown', button });
      assert.deepEqual(sent, expected);
      emitMouse(window, { type: 'mouseUp', button });
      expected.push([`pane:navigate-${button}`]);
      assert.deepEqual(sent, expected);
    }
  }
});

test('actual main window sends one payload-free pane navigation event for each Mouse Forward', () => {
  const { window, sent } = mainWindowForTest();
  window.emit('app-command', { sender: window.webContents }, 'browser-forward', 'untrusted payload');
  assert.deepEqual(sent, [['pane:navigate-forward']]);
  window.emit('app-command', {}, 'browser-forward');
  assert.deepEqual(sent, [['pane:navigate-forward'], ['pane:navigate-forward']]);
});

test('actual main window keeps repeated back and forward commands isolated', () => {
  const { window, sent } = mainWindowForTest();
  for (const command of ['browser-backward', 'browser-forward', 'browser-backward', 'browser-backward', 'browser-forward']) {
    window.emit('app-command', { sender: window.webContents }, command, 'untrusted payload');
  }
  assert.deepEqual(sent, [
    ['pane:navigate-back'], ['pane:navigate-forward'], ['pane:navigate-back'],
    ['pane:navigate-back'], ['pane:navigate-forward'],
  ]);
});

test('actual main window ignores media, unrelated, and incorrectly named app commands', () => {
  const { window, sent } = mainWindowForTest();
  for (const command of ['browser-refresh', 'media-play-pause', 'volume-up',
    'APPCOMMAND_BROWSER_BACKWARD', 'APPCOMMAND_BROWSER_FORWARD', 'browser-back',
    'Browser-Forward', 'browser-forward ', 'constructor', 'toString', '__proto__', '', undefined, null]) {
    window.emit('app-command', {}, command);
  }
  assert.deepEqual(sent, []);
});

for (const [direction, command, subscription] of [
  ['back', 'browser-backward', 'onNavigateBack'],
  ['forward', 'browser-forward', 'onNavigateForward'],
]) {
  const channel = `pane:navigate-${direction}`;
  const otherChannel = `pane:navigate-${direction === 'back' ? 'forward' : 'back'}`;
  const otherSubscription = direction === 'back' ? 'onNavigateForward' : 'onNavigateBack';

  test(`actual main window sends one payload-free ${direction} on mouseUp and none on mouseDown`, () => {
    const { window, sent } = mainWindowForTest();
    emitMouse(window, { type: 'mouseDown', button: direction, x: 10, y: 20, clickCount: 1 });
    assert.deepEqual(sent, []);
    emitMouse(window, { type: 'mouseUp', button: direction, x: 10, y: 20, clickCount: 1 });
    assert.deepEqual(sent, [[channel]]);
  });

  test(`actual main window prevents renderer ${direction} mouseDown and mouseUp defaults`, () => {
    const { window } = mainWindowForTest();
    for (const type of ['mouseDown', 'mouseUp']) {
      assert.equal(emitMouse(window, { type, button: direction }).defaultPrevented, true, type);
    }
  });

  test(`actual main window ignores ${direction} mouseUp if destroyed or closed after mouseDown`, () => {
    for (const state of ['window-destroyed', 'contents-destroyed', 'closed']) {
      const { window, sent } = mainWindowForTest();
      emitMouse(window, { type: 'mouseDown', button: direction });
      emitMouse(window, { type: 'mouseUp', button: direction });
      assert.deepEqual(sent, [[channel]], state);
      sent.length = 0;
      emitMouse(window, { type: 'mouseDown', button: direction });
      if (state === 'window-destroyed') window.destroyed = true;
      if (state === 'contents-destroyed') window.webContents.destroyed = true;
      if (state === 'closed') window.emit('closed');
      assert.doesNotThrow(() => emitMouse(window, { type: 'mouseUp', button: direction }), state);
      assert.deepEqual(sent, [], state);
    }
  });

  test(`actual main window ignores stale ${direction} mouse events while the current window still works`, () => {
    const { window, sent, createWindow } = mainWindowForTest();
    emitMouse(window, { type: 'mouseDown', button: direction });
    const currentWindow = createWindow();
    emitMouse(window, { type: 'mouseUp', button: direction });
    emitMouse(window, { type: 'mouseDown', button: direction });
    emitMouse(window, { type: 'mouseUp', button: direction });
    assert.deepEqual(sent, []);
    emitMouse(currentWindow, { type: 'mouseDown', button: direction });
    assert.deepEqual(sent, []);
    emitMouse(currentWindow, { type: 'mouseUp', button: direction });
    assert.deepEqual(sent, [[channel]]);
  });

  test(`actual main window ignores ${direction} after window or webContents destruction or closure`, () => {
    for (const state of ['window-destroyed', 'contents-destroyed', 'closed']) {
      const { window, sent } = mainWindowForTest();
      // First verify this fixture has a working navigation route.
      window.emit('app-command', {}, command);
      assert.deepEqual(sent, [[channel]], state);
      sent.length = 0;
      if (state === 'window-destroyed') window.destroyed = true;
      if (state === 'contents-destroyed') window.webContents.destroyed = true;
      if (state === 'closed') window.emit('closed');
      assert.doesNotThrow(() => window.emit('app-command', {}, command), state);
      assert.deepEqual(sent, [], state);
    }
  });

  test(`actual main window ignores ${direction} from a stale window while the current window still works`, () => {
    const { window, sent, createWindow } = mainWindowForTest();
    window.emit('app-command', {}, command);
    assert.deepEqual(sent, [[channel]]);
    sent.length = 0;
    const currentWindow = createWindow();
    assert.notEqual(currentWindow, window);
    window.emit('app-command', {}, command);
    assert.deepEqual(sent, []);
    currentWindow.emit('app-command', {}, command);
    assert.deepEqual(sent, [[channel]]);
  });

  test(`actual preload isolates ${direction} and hides the Electron event and all arguments`, () => {
    const { pane, ipcRenderer } = preloadForTest();
    const calls = [];
    const unsubscribe = pane[subscription](function (...args) { calls.push({ args, receiver: this }); });
    ipcRenderer.emit(otherChannel, { sender: ipcRenderer }, 'untrusted payload');
    ipcRenderer.emit('pane:navigate-unknown', { sender: ipcRenderer });
    assert.deepEqual(calls, []);
    ipcRenderer.emit(channel, { sender: ipcRenderer }, 'untrusted payload', { path: 'C:\\' });
    assert.deepEqual(calls, [{ args: [], receiver: undefined }]);
    unsubscribe();
    assert.deepEqual(ipcRenderer.eventNames(), []);
  });

  test(`actual preload ${direction} unsubscribe removes only its subscription and can be called twice`, () => {
    const { pane, ipcRenderer } = preloadForTest();
    let calls = 0;
    const callback = () => { calls += 1; };
    const unsubscribe = pane[subscription](callback);
    const unsubscribeSameDirection = pane[subscription](callback);
    const unsubscribeOtherDirection = pane[otherSubscription](callback);
    assert.equal(typeof unsubscribe, 'function');
    ipcRenderer.emit(channel, {});
    assert.equal(calls, 2);
    unsubscribe();
    unsubscribe();
    assert.equal(ipcRenderer.listenerCount(channel), 1);
    assert.equal(ipcRenderer.listenerCount(otherChannel), 1);
    ipcRenderer.emit(channel, {});
    assert.equal(calls, 3);
    ipcRenderer.emit(otherChannel, {});
    assert.equal(calls, 4);
    unsubscribeSameDirection();
    assert.equal(ipcRenderer.listenerCount(channel), 0);
    ipcRenderer.emit(channel, {});
    assert.equal(calls, 4);
    ipcRenderer.emit(otherChannel, {});
    assert.equal(calls, 5);
    unsubscribeOtherDirection();
    assert.deepEqual(ipcRenderer.eventNames(), []);
    ipcRenderer.emit(otherChannel, {});
    assert.equal(calls, 5);

    for (let cycle = 0; cycle < 20; cycle += 1) {
      const stop = pane[subscription](callback);
      assert.equal(ipcRenderer.listenerCount(channel), 1);
      ipcRenderer.emit(channel, {});
      assert.equal(calls, 6 + cycle);
      stop();
      assert.deepEqual(ipcRenderer.eventNames(), []);
    }
  });

  test(`actual preload ${direction} rejects invalid callbacks before registering any listener`, () => {
    const { pane, ipcRenderer } = preloadForTest();
    assert.equal(typeof pane[subscription], 'function');
    for (const callback of [undefined, null, false, 42, channel, {}, []]) {
      assert.throws(() => pane[subscription](callback), { name: 'TypeError' });
      assert.deepEqual(ipcRenderer.eventNames(), []);
    }
  });
}
