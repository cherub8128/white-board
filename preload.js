const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  setClickThrough: (through) => ipcRenderer.send('set-click-through', through),
  quit: () => ipcRenderer.send('quit-app'),
  minimize: () => ipcRenderer.send('minimize-app'),
  onShortcut: (cb) => ipcRenderer.on('shortcut', (_e, name) => cb(name)),

  // 정보 / 업데이트
  getInfo: () => ipcRenderer.invoke('app-info'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  checkUpdate: () => ipcRenderer.send('check-update'),
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (_e, info) => cb(info)),
  onUpdateNone: (cb) => ipcRenderer.on('update-none', (_e, info) => cb(info))
});
