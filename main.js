const { app, BrowserWindow, ipcMain, screen, globalShortcut, shell, net } = require('electron');
const path = require('path');

const REPO = 'cherub8128/white-board';
const HOMEPAGE = 'https://pi-dimension.com';
const RELEASES_URL = 'https://github.com/' + REPO + '/releases';

// GPU 가속 + 부드러운 합성 (전자칠판 OPS 환경에서 안정적인 옵션)
app.commandLine.appendSwitch('enable-features', 'CalculateNativeWinOcclusion');
// 시작 속도: 불필요한 서브시스템을 끄고 오버레이가 백그라운드로 판정돼 느려지지 않게 한다
app.commandLine.appendSwitch('disable-features',
  'HardwareMediaKeyHandling,MediaSessionService,SpareRendererForSitePerProcess');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

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
    show: false,                 // 첫 페인트가 끝난 뒤 한 번에 표시 (깜빡임 없이 더 빨리 뜬다)
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
      v8CacheOptions: 'code'
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 시작은 "마우스 모드" = 클릭 통과
  win.setIgnoreMouseEvents(true, { forward: true });

  win.once('ready-to-show', () => {
    win.show();
    win.setAlwaysOnTop(true, 'screen-saver');
    setupBackgroundTasks();     // 창이 뜬 뒤에 단축키·업데이트 확인을 준비한다
  });

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
  req.setHeader('User-Agent', 'PiPen');
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

/* 창이 화면에 뜬 뒤에 실행되는 준비 작업 — 시작 경로에서 빼내 첫 표시를 앞당긴다 */
function setupBackgroundTasks() {
  // 전역 단축키: 펜/마우스 즉시 전환, 전체 지우기
  globalShortcut.register('Alt+P', () => win && win.webContents.send('shortcut', 'toggle-mode'));
  globalShortcut.register('Alt+X', () => win && win.webContents.send('shortcut', 'clear'));
  globalShortcut.register('Alt+Z', () => win && win.webContents.send('shortcut', 'undo'));
  globalShortcut.register('Alt+Y', () => win && win.webContents.send('shortcut', 'redo'));

  // 디스플레이 변경 시 창 크기 재조정
  const resize = () => {
    if (!win) return;
    win.setBounds(screen.getPrimaryDisplay().bounds);
    win.webContents.send('shortcut', 'resize');
  };
  screen.on('display-metrics-changed', resize);
  screen.on('display-added', resize);
  screen.on('display-removed', resize);

  setTimeout(() => checkUpdate(false), 8000);   // 자동 업데이트 확인
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
