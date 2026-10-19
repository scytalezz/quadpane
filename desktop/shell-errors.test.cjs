'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const channels = {
  'pane:shell-menu': '메뉴',
  'pane:read-shell-clipboard': '클립보드',
  'pane:write-shell-clipboard': '클립보드',
  'pane:complete-shell-paste': '클립보드',
  'pane:begin-native-drag': '드래그',
  'pane:cancel-shell': '취소',
};

// Load the actual main IPC handlers with Electron and disk-writing startup stubbed.
function handlersFor(error) {
  const handlers = new Map();
  const webContents = { mainFrame: { url: require('node:url').pathToFileURL(path.join(__dirname, '..', 'index.html')).href }, getZoomFactor: () => 1 };
  const app = { isPackaged: false, setPath() {}, exit() {}, enableSandbox() {}, setAppUserModelId() {},
    requestSingleInstanceLock: () => false, quit() {}, getVersion: () => '0.9.0' };
  const context = {
    __dirname, process, console, Buffer,
    require(name) {
      if (name === 'electron') return { app, ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
        screen: { dipToScreenPoint: point => point } };
      if (name === 'node:fs') return { mkdirSync() {}, openSync() {}, closeSync() {}, unlinkSync() {} };
      if (name === './shell-menu.cjs') return { createShellMenuService: () => ({ show: async () => { throw error; }, cancel() { throw error; } }) };
      if (name === './session-store.cjs') return { createSessionStore: () => ({}) };
      if (name === './preferences-store.cjs') return { createPreferencesStore: () => ({}) };
      return require(name);
    },
    testWindow: { webContents, getContentBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
      getNativeWindowHandle: () => Buffer.alloc(8), isDestroyed: () => false },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8') + '\nmainWindow = testWindow; registerFileAccess();', context);
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  return { invoke: (channel, request) => handlers.get(channel)(event, request) };
}

function requestFor(channel) {
  if (channel === 'pane:begin-native-drag') return [path.join(__dirname, 'main.cjs')];
  return { x: 1, y: 1, parent: __dirname, paths: [], sources: [path.join(__dirname, 'main.cjs')],
    operation: 'copy', sequence: 1, completed: [] };
}

test('all actual shell IPC handlers preserve codes and native details with Korean operation messages', async () => {
  for (const code of ['SHELL_BUSY', 'SHELL_CANCELLED', 'SHELL_HELPER_EXITED', 'SHELL_RECOVERY_FAILED', 'SHELL_NATIVE_ERROR', 'EACCES']) {
    const native = 'COM failure 0x800401D0';
    const ipc = handlersFor(Object.assign(new Error(native), { code, nativeError: native, hresult: -2147221040 }));
    for (const [channel, operation] of Object.entries(channels)) {
      const result = await ipc.invoke(channel, requestFor(channel));
      assert.equal(result.ok, false, channel);
      assert.equal(result.error.code, code, channel);
      assert.match(result.error.message, new RegExp(operation), channel);
      assert.doesNotMatch(result.error.message, /폴더.*권한|폴더를 읽/);
      assert.equal(result.error.details, native);
      assert.equal(result.error.nativeError, native);
      assert.equal(result.error.hresult, -2147221040);
      if (code === 'SHELL_CANCELLED') assert.match(result.error.message, /취소/);
    }
  }
});

test('uncoded shell errors and handler validation failures never become READ_FAILED', async () => {
  const ipc = handlersFor(new Error('Uncoded helper error'));
  for (const [channel, operation] of Object.entries(channels)) {
    const result = await ipc.invoke(channel, requestFor(channel));
    assert.equal(result.error.code, 'SHELL_FAILED');
    assert.match(result.error.message, new RegExp(operation));
    assert.equal(result.error.details, 'Uncoded helper error');
  }
  for (const channel of ['pane:shell-menu', 'pane:write-shell-clipboard', 'pane:complete-shell-paste', 'pane:begin-native-drag']) {
    const result = await ipc.invoke(channel, null);
    assert.notEqual(result.error.code, 'READ_FAILED', channel);
    assert.match(result.error.message, new RegExp(channels[channel]));
    assert.ok(result.error.details);
  }
});

test('shell mapper is explicitly included in packaged app', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('desktop/shell-errors.cjs'));
});

test('timeout IPC errors retain uncertainty and never advise blindly repeating a file mutation', async () => {
  for (const outcomeUncertain of [true, false]) {
    const details = { code: 'SHELL_TIMEOUT', requestId: '7', mode: 'drag', phase: 'worker',
      timeoutMs: 30000, outcomeUncertain, retryable: false };
    const ipc = handlersFor(Object.assign(new Error('Windows shell worker exceeded 30000ms'), details));
    for (const [channel, operation] of Object.entries(channels)) {
      const result = await ipc.invoke(channel, requestFor(channel));
      for (const [key, value] of Object.entries(details)) assert.equal(result.error[key], value, key);
      assert.match(result.error.message, new RegExp(operation));
      assert.match(result.error.message, /초과/);
      assert.match(result.error.message, /자동으로 다시 시도하지 않습니다/);
      assert.doesNotMatch(result.error.message, /다시 시도해 주세요/);
      if (outcomeUncertain) assert.match(result.error.message, /일부 또는 전부 실행되었을 수 있어 결과를 확인할 수 없습니다/);
      else assert.match(result.error.message, /실행 전에 취소/);
    }
  }
});

test('a timeout without certainty metadata conservatively reports an unknown outcome', () => {
  const { shellErrorResult } = require('./shell-errors.cjs');
  const result = shellErrorResult({ code: 'SHELL_TIMEOUT', message: 'expired' }, 'pane:shell-menu');
  assert.match(result.error.message, /결과를 확인할 수 없습니다/);
});
