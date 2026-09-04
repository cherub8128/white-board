const { app, BrowserWindow, ipcMain, screen, globalShortcut, shell, net, desktopCapturer } = require('electron');
const path = require('path');

const REPO = 'cherub8128/white-board';
const HOMEPAGE = 'https://pi-dimension.com';
const RELEASES_URL = 'https://github.com/' + REPO + '/releases';

// 오버레이는 다른 창에 가려져도 계속 그려져야 하므로 가림(occlusion) 판정을 끈다.
// 이 판정이 켜져 있으면 전체화면 앱이 위에 오는 순간 렌더링이 멈출 수 있다.
app.commandLine.appendSwitch('disable-features',
  'CalculateNativeWinOcclusion,HardwareMediaKeyHandling,MediaSessionService,SpareRendererForSitePerProcess');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

/* 창 두 개로 나눈 이유:
 * 한 창으로 만들면 "마우스 모드"에서 창 전체를 클릭 통과시켜야 하는데,
 * 그러면 툴바도 같이 통과돼 버린다. 예전에는 forward 된 mousemove 로 커서가 툴바
 * 위에 왔는지 보고 통과를 껐다 켰지만, 그 이벤트는 얼마 지나지 않아 끊기고
 * 터치 화면에는 hover 자체가 없어서 툴바가 아예 눌리지 않게 되는 문제가 있었다.
 * 그래서 그림을 그리는 오버레이 창과, 항상 클릭을 받는 툴바 창을 분리한다. */
let overlayWin = null;   // 전체화면 투명 캔버스 (모드에 따라 클릭 통과)
let toolWin = null;      // 툴바 (항상 클릭 가능, UI 크기에 맞춰 이동/리사이즈)

function primaryBounds() {
  return screen.getPrimaryDisplay().bounds;
}

function createOverlay() {
  const { x, y, width, height } = primaryBounds();
  overlayWin = new BrowserWindow({
    x, y, width, height,
    transparent: true, frame: false, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false,
    hasShadow: false, backgroundColor: '#00000000',
    alwaysOnTop: true, skipTaskbar: false, show: false, paintWhenInitiallyHidden: true,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false, spellcheck: false, v8CacheOptions: 'code'
    }
  });

  overlayWin.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
  overlayWin.setIgnoreMouseEvents(true);      // 시작은 통과 (펜 모드가 되면 렌더러가 해제)

  overlayWin.once('ready-to-show', () => {
    overlayWin.show();
    // 툴바보다 한 단계 낮은 레벨 — 툴바가 항상 오버레이 위에 오도록
    overlayWin.setAlwaysOnTop(true, 'pop-up-menu');
    createToolbar();
    setupBackgroundTasks();
  });

  overlayWin.on('closed', () => { overlayWin = null; app.quit(); });
}

function createToolbar() {
  const { x, y } = primaryBounds();
  toolWin = new BrowserWindow({
    x: x + 40, y: y + 300, width: 120, height: 120,
    transparent: true, frame: false, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false,
    hasShadow: false, backgroundColor: '#00000000',
    alwaysOnTop: true, skipTaskbar: true, focusable: false,   // 다른 앱의 포커스를 빼앗지 않는다
    show: false, paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false, spellcheck: false, v8CacheOptions: 'code'
    }
  });

  toolWin.loadFile(path.join(__dirname, 'renderer', 'toolbar.html'));
  toolWin.once('ready-to-show', () => {
    toolWin.show();
    toolWin.setAlwaysOnTop(true, 'screen-saver');
  });
  toolWin.on('closed', () => { toolWin = null; });
}

/* ---------------- 창 사이 중계 ---------------- */

/* 툴바가 계산한 UI 영역에 맞춰 툴바 창을 옮긴다 (보이는 부분만 클릭을 받도록 최소 크기로).
 *
 * 드래그 중에는 창을 아예 건드리지 않는다.
 * 예전에는 손가락이 움직일 때마다 setBounds 로 창을 옮겼는데, 창을 옮기는 일은
 * 렌더러의 포인터 이벤트보다 느리게 반영된다. 그래서 "창을 옮김 -> 다음 이벤트가
 * 옛 위치 기준으로 들어옴 -> 다시 옮김" 이 반복되며 툴바가 부르르 떨렸다.
 * 터치는 마우스보다 이벤트가 훨씬 촘촘해서 전자칠판에서 특히 심했다.
 * 이제는 드래그가 시작되면 툴바 창을 화면 전체 크기로 한 번만 키우고, 그 안에서
 * CSS 로만 움직인다. 손을 떼면 다시 UI 크기에 딱 맞춘다. */
let lastBounds = null;
let dragging = false;

function applyToolbarBounds(nb) {
  if (!toolWin || toolWin.isDestroyed()) return;
  if (lastBounds && nb.x === lastBounds.x && nb.y === lastBounds.y &&
      nb.width === lastBounds.width && nb.height === lastBounds.height) return;   // 같은 값 재설정 방지
  lastBounds = nb;
  toolWin.setBounds(nb);
  toolWin.moveTop();
}

ipcMain.on('toolbar-bounds', (_e, b) => {
  if (!toolWin || dragging) return;
  applyToolbarBounds({
    x: Math.round(b.x), y: Math.round(b.y),
    width: Math.max(1, Math.round(b.width)), height: Math.max(1, Math.round(b.height))
  });
});

ipcMain.on('toolbar-dragging', (_e, on) => {
  if (!toolWin || toolWin.isDestroyed()) return;
  dragging = !!on;
  if (dragging) applyToolbarBounds(primaryBounds());   // 드래그 동안만 전체 화면
});

// 오버레이가 입력을 받을지 (펜 모드 = 받음, 마우스/통과 모드 = 통과)
ipcMain.on('overlay-interactive', (_e, interactive) => {
  if (!overlayWin) return;
  overlayWin.setIgnoreMouseEvents(!interactive);
  raiseToolbar();
});

/* 툴바는 어떤 경우에도 오버레이 위에 있어야 클릭을 받는다.
 * 다른 앱이 z-order 를 흔드는 경우가 있어 획이 끝날 때마다, 그리고 주기적으로 다시 올린다.
 * 다만 필기 중에는 쉰다 — 창을 다시 띄우는 일은 화면 합성을 건드려서,
 * 그리는 동안 반복되면 아래 화면의 애니메이션이 끊긴다. */
let drawing = false;
function raiseToolbar() {
  if (!toolWin || toolWin.isDestroyed() || drawing) return;
  toolWin.setAlwaysOnTop(true, 'screen-saver');
  toolWin.moveTop();
}
ipcMain.on('raise-toolbar', raiseToolbar);
ipcMain.on('overlay-drawing', (_e, on) => { drawing = !!on; });

// 모달을 띄울 때만 오버레이가 키보드를 받도록 (Esc 로 닫기)
ipcMain.on('overlay-focusable', (_e, on) => {
  if (!overlayWin) return;
  overlayWin.setFocusable(!!on);
  if (on) overlayWin.focus();
  raiseToolbar();
});

// 툴바 -> 오버레이 (도구 상태, 명령)
ipcMain.on('to-overlay', (_e, msg) => {
  if (overlayWin) overlayWin.webContents.send('from-toolbar', msg);
});

// 오버레이 -> 툴바 (팜 접촉 크기 등)
ipcMain.on('to-toolbar', (_e, msg) => {
  if (toolWin) toolWin.webContents.send('from-overlay', msg);
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

ipcMain.on('quit-app', () => app.quit());

/* ---------------- 업데이트 확인: GitHub Releases ---------------- */
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
  const send = (ch, payload) => { if (overlayWin) overlayWin.webContents.send(ch, payload); };
  const req = net.request('https://api.github.com/repos/' + REPO + '/releases/latest');
  req.setHeader('User-Agent', 'PiPen');
  req.setHeader('Accept', 'application/vnd.github+json');
  req.on('response', (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => {
      try {
        const r = JSON.parse(body);
        if (!r.tag_name) throw new Error('no tag');
        const latest = String(r.tag_name).replace(/^v/, '');
        const current = app.getVersion();
        if (cmpVersion(latest, current) > 0) {
          send('update-available', { latest, current, notes: r.body || '', url: r.html_url || RELEASES_URL });
        } else if (manual) {
          send('update-none', { current });
        }
      } catch (_) {
        if (manual) send('update-none', { current: app.getVersion(), failed: true });
      }
    });
  });
  req.on('error', () => { if (manual) send('update-none', { current: app.getVersion(), failed: true }); });
  req.end();
}

ipcMain.on('check-update', () => checkUpdate(true));

/* ---------------- 화면 스냅샷 ----------------
 * "자동 대비" 펜이 아래 화면의 색을 읽어 반전색을 고르기 위한 것.
 * 투명 창은 아래 화면과 직접 블렌딩할 수 없어서, 화면을 작게 찍어 색을 샘플링한다. */
let capturing = false;
ipcMain.handle('capture-screen', async () => {
  if (capturing) return null;
  capturing = true;
  try {
    const d = screen.getPrimaryDisplay();
    const w = 320;
    const h = Math.max(1, Math.round(d.size.height / d.size.width * w));
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: w, height: h } });
    const src = sources.find(s => String(s.display_id) === String(d.id)) || sources[0];
    if (!src || src.thumbnail.isEmpty()) return null;
    return { dataURL: src.thumbnail.toDataURL(), width: w, height: h };
  } catch (_) {
    return null;             // 캡처 실패 시 자동 대비는 마지막 색을 유지한다
  } finally {
    capturing = false;
  }
});

/* 창이 뜬 뒤에 실행되는 준비 작업 — 시작 경로에서 빼내 첫 표시를 앞당긴다 */
function setupBackgroundTasks() {
  const toToolbar = (name) => () => { if (toolWin) toolWin.webContents.send('shortcut', name); };
  globalShortcut.register('Alt+P', toToolbar('toggle-mode'));
  globalShortcut.register('Alt+X', toToolbar('clear'));
  globalShortcut.register('Alt+Z', toToolbar('undo'));
  globalShortcut.register('Alt+Y', toToolbar('redo'));

  const resize = () => {
    if (!overlayWin) return;
    overlayWin.setBounds(primaryBounds());
    overlayWin.webContents.send('shortcut', 'resize');
    if (toolWin) toolWin.webContents.send('shortcut', 'resize');
  };
  screen.on('display-metrics-changed', resize);
  screen.on('display-added', resize);
  screen.on('display-removed', resize);

  setTimeout(() => checkUpdate(false), 8000);
  setInterval(raiseToolbar, 5000);     // z-order 보험 (필기 중에는 건너뛴다)
}

app.whenReady().then(() => {
  createOverlay();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createOverlay();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
