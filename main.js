const { app, BrowserWindow, ipcMain, screen, globalShortcut, shell, net } = require('electron');
const path = require('path');

const REPO = 'cherub8128/white-board';
const HOMEPAGE = 'https://pi-dimension.com';
const RELEASES_URL = 'https://github.com/' + REPO + '/releases';

// GPU 가속 + 부드러운 합성 (전자칠판 OPS 환경에서 안정적인 옵션)
app.commandLine.appendSwitch('enable-features', 'CalculateNativeWinOcclusion');

let win = null;

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.bounds;

  win = new BrowserWindow({
    x, y, width, height,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 시작은 "마우스 모드" = 클릭 통과
  win.setIgnoreMouseEvents(true, { forward: true });

  win.on('closed', () => { win = null; });
}

// 렌더러가 요청하는 클릭 통과 토글
ipcMain.on('set-click-through', (_e, through) => {
  if (!win) return;
  if (through) win.setIgnoreMouseEvents(true, { forward: true });
  else win.setIgnoreMouseEvents(false);
});

ipcMain.handle('app-info', () => ({
  version: app.getVersion(),
  homepage: HOMEPAGE,
  releases: RELEASES_URL,
  repo: 'https://github.com/' + REPO
}));

ipcMain.on('open-external', (_e, url) => {
  // 앱이 직접 정한 링크만 외부 브라우저로 연다
  const allowed = [HOMEPAGE, RELEASES_URL, 'https://github.com/' + REPO];
  if (allowed.some(a => String(url).startsWith(a))) shell.openExternal(url);
});

/* ---------- 업데이트 확인: GitHub Releases ---------- */
function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

function checkUpdate(manual) {
  const req = net.request('https://api.github.com/repos/' + REPO + '/releases/latest');
  req.setHeader('User-Agent', 'WhiteboardPen');
  req.setHeader('Accept', 'application/vnd.github+json');
  req.on('response', (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => {
      if (!win) return;
      try {
        const r = JSON.parse(body);
        if (!r.tag_name) throw new Error('no tag');
        const latest = String(r.tag_name).replace(/^v/, '');
        const current = app.getVersion();
        if (cmpVersion(latest, current) > 0) {
          win.webContents.send('update-available', {
            latest, current, notes: r.body || '', url: r.html_url || RELEASES_URL
          });
        } else if (manual) {
          win.webContents.send('update-none', { current });
        }
      } catch (_) {
        if (manual && win) win.webContents.send('update-none', { current: app.getVersion(), failed: true });
      }
    });
  });
  req.on('error', () => {
    if (manual && win) win.webContents.send('update-none', { current: app.getVersion(), failed: true });
  });
  req.end();
}

ipcMain.on('check-update', () => checkUpdate(true));

ipcMain.on('quit-app', () => app.quit());
ipcMain.on('minimize-app', () => { if (win) win.minimize(); });

app.whenReady().then(() => {
  createWindow();

  // 시작 5초 후 자동 업데이트 확인
  setTimeout(() => checkUpdate(false), 5000);

  // 전역 단축키: 펜/마우스 즉시 전환, 전체 지우기
  globalShortcut.register('Alt+P', () => win && win.webContents.send('shortcut', 'toggle-mode'));
  globalShortcut.register('Alt+X', () => win && win.webContents.send('shortcut', 'clear'));
  globalShortcut.register('Alt+Z', () => win && win.webContents.send('shortcut', 'undo'));
  globalShortcut.register('Alt+Y', () => win && win.webContents.send('shortcut', 'redo'));

  // 디스플레이 변경 시 창 크기 재조정
  const resize = () => {
    if (!win) return;
    const b = screen.getPrimaryDisplay().bounds;
    win.setBounds(b);
    win.webContents.send('shortcut', 'resize');
  };
  screen.on('display-metrics-changed', resize);
  screen.on('display-added', resize);
  screen.on('display-removed', resize);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
