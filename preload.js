'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('keryx', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome
  },

  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),
  leaveFullscreen: () => ipcRenderer.send('window:leave-fullscreen'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  showAbout: () => ipcRenderer.invoke('app:about'),

  onWindowState: (callback) => subscribe('window:state', callback),
  onShortcut: (callback) => subscribe('browser:shortcut', callback),
  onOpenTab: (callback) => subscribe('browser:open-tab', callback),
  onSearch: (callback) => subscribe('browser:search', callback),
  onDownload: (callback) => subscribe('browser:download', callback)
});
