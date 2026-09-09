const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('season', {
  isApp: true,
  platform: process.platform,
  onOpenTab: (cb) => ipcRenderer.on('open-tab', (_e, payload) => cb(payload)),
  onShortcut: (cb) => ipcRenderer.on('shortcut', (_e, id) => cb(id)),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  setTheme: (mode) => ipcRenderer.invoke('theme', mode),
  term: {
    available: () => ipcRenderer.invoke('term:available'),
    create: (opts) => ipcRenderer.invoke('term:create', opts),
    write: (id, data) => ipcRenderer.send('term:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('term:resize', id, cols, rows),
    kill: (id) => ipcRenderer.send('term:kill', id),
    onData: (cb) => ipcRenderer.on('term:data', (_e, payload) => cb(payload)),
    onExit: (cb) => ipcRenderer.on('term:exit', (_e, payload) => cb(payload)),
  },
});
