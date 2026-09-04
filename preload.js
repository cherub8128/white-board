const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pipen', {
  // 오버레이 창
  setOverlayInteractive: (on) => ipcRenderer.send('overlay-interactive', on),
  setOverlayFocusable: (on) => ipcRenderer.send('overlay-focusable', on),
  raiseToolbar: () => ipcRenderer.send('raise-toolbar'),
  setDrawing: (on) => ipcRenderer.send('overlay-drawing', on),
  captureScreen: () => ipcRenderer.invoke('capture-screen'),

  // 툴바 창 위치/크기 (보이는 UI 영역에 딱 맞춘다)
  setToolbarBounds: (b) => ipcRenderer.send('toolbar-bounds', b),
  setToolbarDragging: (on) => ipcRenderer.send('toolbar-dragging', on),

  // 창 사이 메시지
  toOverlay: (msg) => ipcRenderer.send('to-overlay', msg),
  toToolbar: (msg) => ipcRenderer.send('to-toolbar', msg),
  onFromToolbar: (cb) => ipcRenderer.on('from-toolbar', (_e, m) => cb(m)),
  onFromOverlay: (cb) => ipcRenderer.on('from-overlay', (_e, m) => cb(m)),

  // 공통
  onShortcut: (cb) => ipcRenderer.on('shortcut', (_e, name) => cb(name)),
  getInfo: () => ipcRenderer.invoke('app-info'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  checkUpdate: () => ipcRenderer.send('check-update'),
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (_e, i) => cb(i)),
  onUpdateNone: (cb) => ipcRenderer.on('update-none', (_e, i) => cb(i)),
  quit: () => ipcRenderer.send('quit-app')
});
