const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('season', {
  isApp: true,
  platform: process.platform,
  onOpenTab: (cb) => ipcRenderer.on('open-tab', (_e, payload) => cb(payload)),
  onShortcut: (cb) => ipcRenderer.on('shortcut', (_e, id) => cb(id)),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  setTheme: (mode) => ipcRenderer.invoke('theme', mode),
});
