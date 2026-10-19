const { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, shell, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { discoverDrives, getFavorites, listDirectory, closeDirectoryReader, errorResult } = require('./filesystem.cjs');
const { createSessionStore } = require('./session-store.cjs');
const { createPreferencesStore } = require('./preferences-store.cjs');
const { createTransferService, transferError } = require('./file-operations.cjs');
const { createExplorerActions, createMutationCoordinator, actionError, validatePaths } = require('./explorer-actions.cjs');
const { createShellMenuService } = require('./shell-menu.cjs');
const { shellErrorResult } = require('./shell-errors.cjs');
const { createTaskbarIntegration } = require('./taskbar.cjs');
const { createUpdateService } = require('./update-service.cjs');
const { createUpdateFetch } = require('./update-fetch.cjs');
const shellMenus = createShellMenuService(app.isPackaged
  ? path.join(process.resourcesPath, 'native', 'Quadpane.Shell.exe')
  : path.join(__dirname, 'native', 'bin', 'Quadpane.Shell.exe'));

const applicationId = 'com.quadpane.app';
const indexPath = path.join(__dirname, '..', 'index.html');
const indexURL = pathToFileURL(indexPath).href;
const portableDirectory = process.env.PORTABLE_EXECUTABLE_DIR;
const dataDirectory = path.join(
  portableDirectory || (app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..')),
  app.isPackaged ? 'quadpane-data' : '.quadpane-dev-data',
);

function ensureWritableDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const probe = path.join(directory, `.write-check-${process.pid}`);
  const descriptor = fs.openSync(probe, 'wx');
  fs.closeSync(descriptor);
  fs.unlinkSync(probe);
}

// Set every Chromium profile path before ready so preferences travel with the EXE.
try {
  ensureWritableDirectory(dataDirectory);
  for (const [name, child] of [
    ['userData', 'profile'],
    ['sessionData', 'session'],
    ['crashDumps', 'crashes'],
    ['logs', 'logs'],
  ]) {
    const directory = path.join(dataDirectory, child);
    ensureWritableDirectory(directory);
    app.setPath(name, directory);
  }
} catch (error) {
  dialog.showErrorBox('Quadpane 설정 폴더를 만들 수 없습니다',
    `실행 파일 옆의 설정 폴더에 쓸 수 없습니다.\n\n${dataDirectory}\n\n쓰기 가능한 폴더로 Quadpane 실행 파일을 옮긴 뒤 다시 실행해 주세요.\n\n${error.message}`);
  app.exit(1);
}

app.enableSandbox();
app.setAppUserModelId(applicationId);
let mainWindow;
let mainTaskbar;
let updateRestartPending = false;
let updateCheckTimer;
const updateService = createUpdateService({
  currentVersion: app.getVersion(),
  portableDirectory,
  enabled: app.isPackaged && process.platform === 'win32' && process.arch === 'x64'
    && typeof portableDirectory === 'string' && path.isAbsolute(portableDirectory)
    && typeof process.env.PORTABLE_EXECUTABLE_FILE === 'string'
    && path.dirname(process.env.PORTABLE_EXECUTABLE_FILE) === portableDirectory,
  fetch: createUpdateFetch(net),
  onChange: state => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('pane:update-state-changed', state);
    }
  },
});
const sessionStore = createSessionStore(dataDirectory);
const preferencesStore = createPreferencesStore(dataDirectory);
const transferService = createTransferService();
const mutations = createMutationCoordinator();
const explorerActions = createExplorerActions({ shell, mutations });
let quitAfterTransfer = false;
let shellShutdown;
let quitAfterShell = false;
let shellShutdownComplete = false;
const explorerChannels = new Set(['pane:open-path', 'pane:reveal-path', 'pane:trash-items', 'pane:rename-item', 'pane:create-folder', 'pane:begin-native-drag']);

function closeShellMenus() {
  // Share teardown across renderer destruction, window closure and app quit.
  // The service bounds graceful clipboard flushing and owns final exit cleanup.
  if (!shellShutdown) shellShutdown = Promise.resolve().then(() => shellMenus.close()).catch(() => {});
  return shellShutdown;
}

function applicationErrorResult(error, channel) {
  if (channel.startsWith('pane:update-')) {
    return { ok: false, error: { code: error?.code || 'UPDATE_FAILED',
      message: error?.message || '업데이트를 완료하지 못했습니다. 다시 시도해 주세요.' } };
  }
  const shellResult = shellErrorResult(error, channel);
  if (shellResult) return shellResult;
  if (['INVALID_PREFERENCES', 'PREFERENCES_WRITE_FAILED'].includes(error?.code)) {
    return { ok: false, error: { code: error.code, message: error.message } };
  }
  if (explorerChannels.has(channel) || error?.code === 'ACTION_BUSY') return { ok: false, error: actionError(error) };
  return channel === 'pane:transfer' ? { ok: false, error: transferError(error) } : errorResult(error);
}

function registerFileAccess() {
  const handle = (channel, action) => ipcMain.handle(channel, async (event, ...args) => {
    try {
      if (!mainWindow || event.sender !== mainWindow.webContents
        || event.senderFrame !== mainWindow.webContents.mainFrame
        || event.senderFrame.url !== indexURL) {
        return errorResult({ code: 'FORBIDDEN' });
      }
      if (updateRestartPending && (explorerChannels.has(channel)
        || ['pane:transfer', 'pane:shell-menu', 'pane:read-shell-clipboard', 'pane:write-shell-clipboard', 'pane:complete-shell-paste'].includes(channel))) {
        throw Object.assign(new Error('업데이트를 위해 다시 시작하는 중입니다.'), { code: 'ACTION_BUSY' });
      }
      return { ok: true, value: await action(...args) };
    } catch (error) { return applicationErrorResult(error, channel); }
  });
  handle('pane:bootstrap', async () => ({
    update: updateService.getState(),
    drives: await discoverDrives(),
    favorites: getFavorites(name => app.getPath(name)),
    ...sessionStore.load(),
    ...preferencesStore.load(),
  }));
  handle('pane:update-state', () => updateService.getState());
  handle('pane:update-check', () => updateService.check());
  handle('pane:update-download', () => updateService.download());
  handle('pane:update-install', async () => {
    if (updateRestartPending || mutations.pending || shellMenus.pending) {
      throw Object.assign(new Error('진행 중인 파일 작업을 마친 뒤 다시 시도해 주세요.'), { code: 'UPDATE_BUSY' });
    }
    updateRestartPending = true;
    try {
      const executable = await updateService.verifyReady();
      // Relaunch the verified portable launcher, preserving the adjacent data
      // directory. Electron starts it only after this instance has exited.
      app.relaunch({ execPath: executable, args: [] });
      try { mainTaskbar?.retargetPins(executable); } catch { /* Shortcut migration is nonfatal. */ }
      setImmediate(() => app.quit());
      return { restarting: true };
    } catch (error) {
      updateRestartPending = false;
      throw error;
    }
  });
  handle('pane:list-directory', (directory, options) => listDirectory(directory, { accurate: options?.accurate === true }));
  handle('pane:save-session', session => sessionStore.save(session));
  handle('pane:save-preferences', preferences => preferencesStore.save(preferences));
  handle('pane:transfer', request => mutations.run(() => transferService.transfer(request)));
  handle('pane:open-path', filename => explorerActions.openPath(filename));
  handle('pane:reveal-path', filename => explorerActions.revealPath(filename));
  handle('pane:trash-items', request => explorerActions.trashItems(request));
  handle('pane:rename-item', request => explorerActions.renameItem(request));
  handle('pane:create-folder', request => explorerActions.createFolder(request));
  handle('pane:read-shell-clipboard', () => shellMenus.show({}, {}, 'readClipboard'));
  handle('pane:complete-shell-paste', request => {
    if (!Number.isInteger(request?.sequence) || !Array.isArray(request?.completed) || request.completed.length > 1000
      || !request.completed.every(filename => typeof filename === 'string')) throw new Error('Invalid clipboard completion');
    return shellMenus.show({}, request, 'completePaste');
  });
  handle('pane:write-shell-clipboard', request => {
    const files = validatePaths(request?.sources);
    return shellMenus.show({ parent: path.win32.dirname(files[0]), paths: files, operation: request.operation }, {}, 'writeClipboard');
  });
  handle('pane:cancel-shell', async () => {
    const stopped = await shellMenus.cancel();
    if (stopped?.some(result => !result.exited)) {
      throw Object.assign(new Error('Previous Windows shell helper has not exited'), { code: 'SHELL_RECOVERY_FAILED' });
    }
    return null;
  });
  handle('pane:shell-menu', request => mutations.run(async () => {
    const window = mainWindow;
    const bounds = window.getContentBounds();
    const zoom = window.webContents.getZoomFactor();
    if (!Number.isFinite(request?.x) || !Number.isFinite(request?.y)) throw new Error('Invalid menu position');
    const point = screen.dipToScreenPoint({
      x: bounds.x + Math.round(Math.max(0, Math.min(bounds.width, request.x * zoom))),
      y: bounds.y + Math.round(Math.max(0, Math.min(bounds.height, request.y * zoom))),
    });
    const handle = window.getNativeWindowHandle();
    return shellMenus.show(request, { ...point, owner: handle.readBigUInt64LE().toString() });
  }));
  handle('pane:begin-native-drag', request => {
    if (mutations.pending) throw Object.assign(new Error('Busy'), { code: 'ACTION_BUSY' });
    const files = validatePaths(request);
    if (!mainWindow || mainWindow.isDestroyed()) throw Object.assign(new Error('Window closed'), { code: 'ACTION_FAILED' });
    return shellMenus.show({ parent: path.win32.dirname(files[0]), paths: files }, {}, 'drag');
  });
}

function createWindow() {
  const taskbar = app.isPackaged && process.platform === 'win32' ? createTaskbarIntegration({
    isPackaged: app.isPackaged, platform: process.platform, env: process.env,
    execPath: process.execPath, portableDirectory, dataDirectory,
    iconSource: path.join(__dirname, 'quadpane.ico'), applicationId, shell,
    smokeTest: app.commandLine.hasSwitch('pane-smoke-test'),
  }) : null;
  mainTaskbar = taskbar;
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 760,
    minHeight: 540,
    show: false,
    title: 'Quadpane — 파일 탐색기',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#11151c' : '#f4f6f8',
    icon: taskbar?.windowIcon || path.join(__dirname, 'quadpane.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  taskbar?.apply(window);
  mainWindow = window;
  window.setMenu(null);
  // A renderer can disappear without BrowserWindow's normal close path. Retire
  // its helper immediately so a native drag cannot keep global mouse capture.
  const abandonShell = () => { if (mainWindow === window) shellMenus.cancel(); };
  window.webContents.on('render-process-gone', abandonShell);
  window.webContents.on('destroyed', () => {
    if (mainWindow !== window) return;
    if (shellMenus.pending) shellMenus.cancel();
    closeShellMenus();
  });
  const sendPaneNavigation = direction => {
    if (mainWindow !== window
      || window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.send(`pane:navigate-${direction}`);
  };
  window.on('app-command', (_event, command) => {
    if (command !== 'browser-backward' && command !== 'browser-forward') return;
    sendPaneNavigation(command === 'browser-backward' ? 'back' : 'forward');
  });
  window.webContents.on('before-mouse-event', (event, input) => {
    if (input.button !== 'back' && input.button !== 'forward') return;
    if (input.type !== 'mouseDown' && input.type !== 'mouseUp') return;
    // Block both phases so hovering another pane cannot change the active pane.
    event.preventDefault();
    if (input.type === 'mouseUp') sendPaneNavigation(input.button);
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== indexURL) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.on('will-download', event => event.preventDefault());
  window.once('ready-to-show', () => {
    if (!app.commandLine.hasSwitch('pane-smoke-test')) window.show();
  });
  window.on('close', event => {
    if (shellMenus.pending) shellMenus.cancel();
    const pending = mutations.pending;
    if (!pending) return;
    event.preventDefault();
    window.setTitle('Quadpane — 파일 작업을 마친 뒤 종료합니다');
    if (!quitAfterTransfer) {
      quitAfterTransfer = true;
      pending.finally(() => { quitAfterTransfer = false; app.quit(); }).catch(() => {});
    }
  });
  window.on('closed', () => {
    if (mainWindow !== window) return;
    closeShellMenus();
    mainWindow = undefined;
  });
  window.loadFile(indexPath).catch(error => {
    dialog.showErrorBox('Quadpane 화면을 열 수 없습니다', error.message);
    app.quit();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    registerFileAccess();
    shellMenus.start(); // Warm STA helper before the user begins a short drag gesture.
    createWindow();
    if (!app.commandLine.hasSwitch('pane-smoke-test') && updateService.getState().status !== 'unsupported') {
      updateCheckTimer = setTimeout(() => { updateService.check().catch(() => {}); }, 10000);
      updateCheckTimer.unref();
    }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', closeShellMenus);
  app.on('will-quit', closeDirectoryReader);
  app.on('will-quit', () => { clearTimeout(updateCheckTimer); updateService.close(); });
  app.on('before-quit', event => {
    if (shellMenus.pending) shellMenus.cancel();
    if (mutations.pending) {
      event.preventDefault();
      if (!quitAfterTransfer) {
        quitAfterTransfer = true;
        mutations.pending.finally(() => { quitAfterTransfer = false; app.quit(); }).catch(() => {});
      }
      return;
    }
    if (shellShutdownComplete) return;
    event.preventDefault();
    if (quitAfterShell) return;
    quitAfterShell = true;
    clearTimeout(updateCheckTimer);
    Promise.allSettled([closeShellMenus(), updateService.close()])
      .then(() => { shellShutdownComplete = true; app.quit(); });
  });
}
