'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('pane', Object.freeze({
  bootstrap: () => ipcRenderer.invoke('pane:bootstrap'),
  listDirectory: path => ipcRenderer.invoke('pane:list-directory', path),
  saveSession: session => ipcRenderer.invoke('pane:save-session', session),
  savePreferences: preferences => ipcRenderer.invoke('pane:save-preferences', preferences),
  transfer: request => ipcRenderer.invoke('pane:transfer', request),
  openPath: path => ipcRenderer.invoke('pane:open-path', path),
  revealPath: path => ipcRenderer.invoke('pane:reveal-path', path),
  trashItems: request => ipcRenderer.invoke('pane:trash-items', request),
  renameItem: request => ipcRenderer.invoke('pane:rename-item', request),
  createFolder: request => ipcRenderer.invoke('pane:create-folder', request),
  beginNativeDrag: paths => ipcRenderer.invoke('pane:begin-native-drag', paths),
  shellMenu: request => ipcRenderer.invoke('pane:shell-menu', request),
  readShellClipboard: () => ipcRenderer.invoke('pane:read-shell-clipboard'),
  completeShellPaste: request => ipcRenderer.invoke('pane:complete-shell-paste', request),
  writeShellClipboard: request => ipcRenderer.invoke('pane:write-shell-clipboard', request),
  cancelShell: () => ipcRenderer.invoke('pane:cancel-shell'),
  droppedPaths: files => {
    if (!Array.isArray(files) || files.length > 1000) return [];
    // Only real File objects supplied by Chromium expose a filesystem path.
    return files.flatMap(file => {
      try { const path = webUtils.getPathForFile(file); return path ? [path] : []; }
      catch { return []; }
    });
  },
}));
