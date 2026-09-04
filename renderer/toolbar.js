/* ============================================================
 *  Pi Pen — 툴바 창
 *  항상 클릭을 받는 별도 창. 보이는 UI 영역에 딱 맞게 창 크기를 잡고,
 *  도구 상태가 바뀔 때마다 오버레이 창으로 보낸다.
 * ========================================================== */

const dock = document.getElementById('dock');
const fan = document.getElementById('fan');
const fanPanel = document.getElementById('fanPanel');
const handle = document.getElementById('handle');
const pod = document.getElementById('slider');
const colorPanel = document.getElementById('colorPanel');
const sizeRange = document.getElementById('sizeRange');
const sizeValue = document.getElementById('sizeValue');
const sizeLabel = document.getElementById('sizeLabel');
const sizeDot = document.getElementById('sizeDot');
const svArea = document.getElementById('svArea');
const svCtx = svArea.getContext('2d');
const hueRange = document.getElementById('hueRange');
const colorSwatch = document.getElementById('colorSwatch');
const colorHex = document.getElementById('colorHex');

const COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#ffffff', '#1c1c1e'];
const R = 194;            // 반원 반지름
const GAP = 10;           // 패널 간격
const MARGIN = 26;        // 그림자 여백
const HANDLE = 28;        // 핸들 반지름

const S = {
  tool: 'pen',
  eraserMode: 'stroke',
  color: '#ff3b30',
  customColor: '#8a4dff',
  penSize: 6,
  hiSize: 24,
  eraserSize: 40,
  screenLock: true,
  touchWrite: true,
  palmErase: true,
  palmThreshold: 45,
  lastTouchSize: 0,
  touchSizeReported: false,
  fanOpen: true,
  pickerOpen: false,
  submenu: 'color'
};

// 핸들 중심의 화면 좌표 (DIP)
let dockScreen = { x: 60, y: Math.round(window.screen.availHeight / 2) };

/* ---------------- 오버레이로 상태 전달 ---------------- */
const STATE_KEYS = ['tool', 'eraserMode', 'color', 'penSize', 'hiSize', 'eraserSize',
  'screenLock', 'touchWrite', 'palmErase', 'palmThreshold'];

function pushState() {
  const state = {};
  for (const k of STATE_KEYS) state[k] = S[k];
  window.pipen.toOverlay({ state });
}
function sendCmd(cmd, extra) { window.pipen.toOverlay(Object.assign({ cmd }, extra || {})); }
function toast(text) { sendCmd('toast', { text }); }

/* ---------------- 아이콘 ---------------- */
const ICON = {
  pen: '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M3 21l3.6-1 11-11a2.1 2.1 0 0 0-3-3l-11 11L3 21z" fill="currentColor"/></svg>',
  hi: '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M5 17l-1 4 4-1 10-10-3-3L5 17z" fill="currentColor" opacity=".9"/><rect x="3" y="21" width="18" height="2" rx="1" fill="currentColor"/></svg>',
  eraser: '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M6 18l-3-3a2 2 0 0 1 0-3l8-8a2 2 0 0 1 3 0l5 5a2 2 0 0 1 0 3l-6 6H6z" fill="currentColor"/><rect x="3" y="20" width="18" height="2" rx="1" fill="currentColor" opacity=".6"/></svg>',
  mouse: '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M5 3l14 8-6 1.4L10 20 5 3z" fill="currentColor"/></svg>',
  undo: '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M9 7h5a6 6 0 0 1 0 12h-4v-2h4a4 4 0 0 0 0-8H9v3L4 8l5-4v3z" fill="currentColor"/></svg>',
  redo: '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M15 7h-5a6 6 0 0 0 0 12h4v-2h-4a4 4 0 0 1 0-8h5v3l5-4-5-4v3z" fill="currentColor"/></svg>',
  gear: '<svg viewBox="0 0 24 24" width="26" height="26"><path fill-rule="evenodd" d="M19.49 10.2 L22.27 10.37 L22.27 13.63 L19.49 13.8 L18.36 16.53 L20.2 18.62 L17.89 20.92 L15.8 19.09 L13.07 20.22 L12.9 23 L9.64 23 L9.47 20.22 L6.74 19.09 L4.65 20.92 L2.35 18.62 L4.18 16.53 L3.05 13.8 L0.27 13.63 L0.27 10.37 L3.05 10.2 L4.18 7.47 L2.35 5.38 L4.65 3.08 L6.74 4.91 L9.47 3.78 L9.64 1 L12.9 1 L13.07 3.78 L15.8 4.91 L17.89 3.08 L20.2 5.38 L18.36 7.47 Z M8.5 12 A 3.5 3.5 0 1 0 15.5 12 A 3.5 3.5 0 1 0 8.5 12 Z" fill="currentColor"/></svg>',
  info: '<svg viewBox="0 0 24 24" width="26" height="26"><circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" stroke-width="1.9"/><circle cx="12" cy="7.6" r="1.25" fill="currentColor"/><rect x="11" y="10.4" width="2" height="7" rx="1" fill="currentColor"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>'
};

function item(id, icon, label, onclick, opts) {
  return Object.assign({ id, icon, label, onclick }, opts || {});
}

function ring1() {
  return [
    item('pen', ICON.pen, '펜', () => setTool('pen')),
    item('highlighter', ICON.hi, '형광펜', () => setTool('highlighter')),
    item('eraser', ICON.eraser, '지우개', () => setTool('eraser')),
    item('mouse', ICON.mouse, '마우스', () => setTool('mouse')),
    item('undo', ICON.undo, '실행취소', () => sendCmd('undo')),
    item('redo', ICON.redo, '다시실행', () => sendCmd('redo')),
    item('settings', ICON.gear, '설정', () => toggleSubmenu('settings'))
  ];
}

function ring2() {
  if (S.submenu === 'color') {
    const sw = COLORS.map(c => item('c' + c, '<i style="background:' + c + '"></i>', '', () => {
      S.color = c; S.pickerOpen = false; colorPanel.classList.remove('show'); render(); pushState();
    }, { cls: 'color', activeIf: () => S.color === c }));
    // 화면 색을 읽어 반전색으로 그리는 펜 — 어떤 배경에서도 잘 보인다
    sw.push(item('auto', '<i class="auto-swatch"></i>', '자동 대비 (배경 반전색)', () => {
      S.color = 'auto'; S.pickerOpen = false; colorPanel.classList.remove('show');
      render(); pushState(); toast('자동 대비 — 배경색의 반전색으로 그립니다');
    }, { cls: 'color', activeIf: () => S.color === 'auto' }));
    sw.push(item('custom',
      '<i style="background:conic-gradient(#ff3b30,#ffcc00,#34c759,#0ad,#4c8dff,#b45cff,#ff3b30);' +
      'box-shadow:inset 0 0 0 2px ' + S.customColor + '"></i>',
      '기타 색 (RGB 선택)', toggleColorPicker,
      { cls: 'color', activeIf: () => S.pickerOpen || S.color === S.customColor }));
    return sw;
  }

  if (S.submenu === 'eraser')
    return [
      item('e-stroke', '<span class="lbl">획<br>지우기</span>', '획 단위로 지우기',
        () => { S.eraserMode = 'stroke'; render(); pushState(); }, { activeIf: () => S.eraserMode === 'stroke' }),
      item('e-area', '<span class="lbl">영역<br>지우기</span>', '문지른 영역만 지우기',
        () => { S.eraserMode = 'area'; render(); pushState(); }, { activeIf: () => S.eraserMode === 'area' }),
      item('e-all', '<span class="lbl">전체<br>지우기</span>', '모두 지우기', () => sendCmd('clear'))
    ];

  if (S.submenu === 'settings')
    return [
      item('lock', '<span class="lbl">' + (S.screenLock ? '화면<br>고정' : '화면<br>통과') + '</span>',
        '화면 고정 / 아래 화면 조작', () => setScreenLock(!S.screenLock), { toggle: () => S.screenLock }),
      item('touch', '<span class="lbl">터치<br>필기</span>', '손가락 필기 켜기/끄기',
        () => { S.touchWrite = !S.touchWrite; render(); pushState(); toast('터치 필기 ' + (S.touchWrite ? '켜짐' : '꺼짐')); },
        { toggle: () => S.touchWrite }),
      item('palm', '<span class="lbl">팜<br>지우기</span>', '손바닥 · 두 손가락으로 지우기',
        () => { S.palmErase = !S.palmErase; render(); pushState(); toast('팜 지우기 ' + (S.palmErase ? '켜짐' : '꺼짐')); },
        { toggle: () => S.palmErase }),
      item('clear', '<span class="lbl">전체<br>지우기</span>', '모두 지우기', () => sendCmd('clear')),
      item('info', ICON.info, '정보 · 업데이트', () => sendCmd('info')),
      item('quit', ICON.close, '종료', () => window.pipen.quit())
    ];
  return [];
}

function arcAngles(count, centerDeg, spreadDeg) {
  if (count === 1) return [centerDeg];
  const step = spreadDeg / (count - 1);
  return Array.from({ length: count }, (_, i) => centerDeg - spreadDeg / 2 + i * step);
}

function submenuForTool() {
  if (S.tool === 'pen' || S.tool === 'highlighter') return 'color';
  if (S.tool === 'eraser') return 'eraser';
  return null;
}

/* ---------------- 배치 ----------------
 * 좌표계: 핸들 중심을 (0,0) 으로 두고 각 요소의 사각형을 계산한 뒤,
 * 그 합집합에 맞춰 창 크기를 잡고 dock 을 그 안에 배치한다.
 * (창을 UI 크기에 딱 맞춰야 주변 클릭이 막히지 않는다) */
function dockDirection() {
  const w = window.screen.availWidth, h = window.screen.availHeight;
  // 위/아래 가장자리에 가까우면 그쪽으로 눕히고, 아니면 화면 안쪽을 향해 펼친다
  if (dockScreen.y < R) return 'down';
  if (h - dockScreen.y < R) return 'up';
  return dockScreen.x < w / 2 ? 'right' : 'left';
}

function fanRect(dir) {
  if (!S.fanOpen) return null;
  if (dir === 'right') return { x: 0, y: -R, w: R, h: 2 * R };
  if (dir === 'left') return { x: -R, y: -R, w: R, h: 2 * R };
  if (dir === 'down') return { x: -R, y: 0, w: 2 * R, h: R };
  return { x: -R, y: -R, w: 2 * R, h: R };
}

function panelOrigin(dir) {
  if (dir === 'right') return { x: 0, y: R + GAP };
  if (dir === 'left') return { x: -R, y: R + GAP };
  const x = (dockScreen.x + R + GAP + R > window.screen.availWidth) ? -(R + GAP + R) : R + GAP;
  return { x, y: (dir === 'down') ? 0 : -R };
}

function layout() {
  const dir = dockDirection();
  for (const d of ['right', 'left', 'up', 'down']) dock.classList.toggle('dir-' + d, d === dir);

  const rects = [{ x: -HANDLE, y: -HANDLE, w: HANDLE * 2, h: HANDLE * 2 }];
  const fr = fanRect(dir);
  if (fr) rects.push(fr);

  // 서브 패널 (반원 폭과 같은 너비로 이어 붙인다)
  const org = panelOrigin(dir);
  let py = org.y;
  for (const el of [pod, colorPanel]) {
    el.style.width = R + 'px';
    if (!el.classList.contains('show')) { el.style.left = org.x + 'px'; el.style.top = py + 'px'; continue; }
    el.style.left = org.x + 'px';
    el.style.top = py + 'px';
    const h = el.offsetHeight || 90;
    rects.push({ x: org.x, y: py, w: R, h });
    py += h + GAP;
  }

  const minX = Math.min(...rects.map(r => r.x)) - MARGIN;
  const minY = Math.min(...rects.map(r => r.y)) - MARGIN;
  const maxX = Math.max(...rects.map(r => r.x + r.w)) + MARGIN;
  const maxY = Math.max(...rects.map(r => r.y + r.h)) + MARGIN;

  if (dragMode) {
    // 드래그 중에는 창이 화면 전체 크기다. 창은 그대로 두고 dock 만 옮긴다.
    dock.style.left = (dockScreen.x - window.screenX) + 'px';
    dock.style.top = (dockScreen.y - window.screenY) + 'px';
    return dir;
  }

  dock.style.left = (-minX) + 'px';
  dock.style.top = (-minY) + 'px';

  window.pipen.setToolbarBounds({
    x: Math.round(dockScreen.x + minX),
    y: Math.round(dockScreen.y + minY),
    width: Math.round(maxX - minX),
    height: Math.round(maxY - minY)
  });
  return dir;
}

function render() {
  fan.innerHTML = '';
  fan.classList.toggle('open', S.fanOpen);
  fanPanel.classList.toggle('open', S.fanOpen);
  handle.classList.toggle('open', S.fanOpen);
  handle.classList.toggle('mouse-mode', S.tool === 'mouse' || !S.screenLock);

  clampDock();
  const dir = layout();
  updateSlider();

  if (S.fanOpen) {
    const center = { right: 0, left: 180, down: 90, up: -90 }[dir];
    const r1 = ring1(), r2 = ring2();
    place(r1, 101, arcAngles(r1.length, center, 142));
    if (r2.length) place(r2, 157, arcAngles(r2.length, center, 120));
  }

  requestAnimationFrame(layout);   // 패널 표시 여부가 바뀐 뒤의 실제 크기로 한 번 더
  saveSettings();
}

function place(items, radius, angles) {
  items.forEach((it, i) => {
    const b = document.createElement('button');
    b.className = 'fb' + (it.cls ? ' ' + it.cls : '');
    b.innerHTML = it.icon;
    if (it.label) b.title = it.label;
    const isActive = it.activeIf ? it.activeIf()
      : (S.tool === it.id) || (it.id === 'settings' && S.submenu === 'settings');
    if (isActive) b.classList.add('active');
    if (it.toggle) b.classList.add(it.toggle() ? 'toggle-on' : 'toggle-off');
    const rad = angles[i] * Math.PI / 180;
    b.style.transform = 'translate(' + Math.cos(rad) * radius + 'px,' + Math.sin(rad) * radius + 'px) scale(1)';
    b.addEventListener('click', (e) => { e.stopPropagation(); it.onclick(); });
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    fan.appendChild(b);
  });
}

function clampDock() {
  // 핸들만 화면 안에 있으면 된다. 반원은 가장자리 반대쪽으로 펼쳐지므로
  // 여기서 반지름만큼 여백을 두면 화면 끝까지 붙일 수가 없다.
  const w = window.screen.availWidth, h = window.screen.availHeight;
  const pad = HANDLE + 2;
  dockScreen.x = Math.min(Math.max(dockScreen.x, pad), w - pad);
  dockScreen.y = Math.min(Math.max(dockScreen.y, pad), h - pad);
}

function setTool(t) {
  S.tool = t;
  S.submenu = submenuForTool();
  if (t !== 'pen' && t !== 'highlighter') {
    S.pickerOpen = false;
    colorPanel.classList.remove('show');
  }
  if (t === 'mouse') toast('마우스 모드 — 아래 화면을 그대로 조작합니다');
  render();
  pushState();
}

function toggleSubmenu(name) {
  // 설정을 다시 누르면 메뉴가 사라지지 않고 현재 도구의 하위 메뉴로 돌아온다
  S.submenu = (S.submenu === name) ? submenuForTool() : name;
  render();
}

function setScreenLock(lock) {
  S.screenLock = lock;
  render();
  pushState();
  toast(lock ? '화면 고정 — 필기 가능' : '화면 통과 — 아래 화면을 조작할 수 있습니다 (필기 내용은 유지)');
}

/* ---------------- 두께 슬라이더 ---------------- */
const SLIDER_MAX = { penSize: 40, hiSize: 80, eraserSize: 160, palmThreshold: 220 };
const SLIDER_MIN = { penSize: 1, hiSize: 4, eraserSize: 8, palmThreshold: 30 };

function currentSizeKey() {
  if (S.submenu === 'settings') return 'palmThreshold';
  if (S.tool === 'pen') return 'penSize';
  if (S.tool === 'highlighter') return 'hiSize';
  if (S.tool === 'eraser' && S.eraserMode === 'area') return 'eraserSize';
  return null;
}

function updateSlider() {
  const key = currentSizeKey();
  if (!S.fanOpen || !key) { pod.classList.remove('show'); return; }
  pod.classList.add('show');
  sizeRange.min = SLIDER_MIN[key];
  sizeRange.max = SLIDER_MAX[key];
  sizeRange.value = S[key];
  sizeValue.textContent = S[key];

  if (key === 'palmThreshold') {
    // 접촉 크기를 보고하지 않는 기기에서는 크기 기준이 성립하지 않는다.
    // 그런 기기는 동시 접촉 개수로 대신 판단하므로 그 사실을 알려준다.
    sizeLabel.textContent = S.touchSizeReported
      ? '팜 인식 크기 (측정: ' + (S.lastTouchSize || '-') + ') · 두 손가락도 지우개'
      : '이 화면은 접촉 크기를 못 읽습니다 — 손바닥·두 손가락으로 문지르면 지워집니다';
    const d = Math.min(30, Math.max(4, S[key] / 6));
    sizeDot.style.cssText = 'width:' + d + 'px;height:' + d + 'px;background:#9aa1ad';
  } else {
    sizeLabel.textContent = (key === 'eraserSize') ? '지우개 크기' : '두께';
    const d = Math.min(30, Math.max(3, S[key]));
    const dotColor = key === 'eraserSize' ? '#9aa1ad'
      : (S.color === 'auto' ? 'linear-gradient(90deg,#111 50%,#f2f2f2 50%)' : S.color);
    const prop = dotColor.startsWith('linear') ? 'background-image' : 'background';
    sizeDot.style.cssText = 'width:' + d + 'px;height:' + d + 'px;' + prop + ':' + dotColor +
      ';opacity:' + (key === 'hiSize' ? .5 : 1);
  }
}

sizeRange.addEventListener('input', () => {
  const key = currentSizeKey(); if (!key) return;
  S[key] = Number(sizeRange.value);
  updateSlider();
  saveSettings();
  pushState();
});
pod.addEventListener('pointerdown', (e) => e.stopPropagation());

/* ---------------- RGB 색 선택 ---------------- */
let hsv = { h: 0, s: 1, v: 1 };

function hsv2rgb(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
  const t = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h / 60) % 6];
  return t.map(n => Math.round((n + m) * 255));
}
function rgb2hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = 60 * (((g - b) / d) % 6);
    else if (mx === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return { h: (h + 360) % 360, s: mx ? d / mx : 0, v: mx };
}
const hex = (rgb) => '#' + rgb.map(n => n.toString(16).padStart(2, '0')).join('').toUpperCase();
function hex2rgb(h) {
  const m = /^#?([0-9a-f]{6})$/i.exec(h);
  if (!m) return [255, 59, 48];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function drawSV() {
  const w = svArea.clientWidth || 166, h = svArea.clientHeight || 92;
  if (svArea.width !== w || svArea.height !== h) { svArea.width = w; svArea.height = h; }
  const bs = hsv2rgb(hsv.h, 1, 1);
  svCtx.fillStyle = 'rgb(' + bs.join(',') + ')';
  svCtx.fillRect(0, 0, w, h);
  const white = svCtx.createLinearGradient(0, 0, w, 0);
  white.addColorStop(0, 'rgba(255,255,255,1)'); white.addColorStop(1, 'rgba(255,255,255,0)');
  svCtx.fillStyle = white; svCtx.fillRect(0, 0, w, h);
  const black = svCtx.createLinearGradient(0, 0, 0, h);
  black.addColorStop(0, 'rgba(0,0,0,0)'); black.addColorStop(1, 'rgba(0,0,0,1)');
  svCtx.fillStyle = black; svCtx.fillRect(0, 0, w, h);
  const x = hsv.s * w, y = (1 - hsv.v) * h;
  svCtx.beginPath(); svCtx.arc(x, y, 7, 0, Math.PI * 2);
  svCtx.strokeStyle = 'rgba(0,0,0,.55)'; svCtx.lineWidth = 3; svCtx.stroke();
  svCtx.strokeStyle = '#fff'; svCtx.lineWidth = 2; svCtx.stroke();
}

function applyPickedColor() {
  const h = hex(hsv2rgb(hsv.h, hsv.s, hsv.v));
  S.customColor = h;
  S.color = h;
  colorSwatch.style.background = h;
  colorHex.textContent = h;
  drawSV();
  pushState();
}

function setFromHex(h) {
  const [r, g, b] = hex2rgb(h);
  hsv = rgb2hsv(r, g, b);
  hueRange.value = Math.round(hsv.h);
  colorSwatch.style.background = h;
  colorHex.textContent = h;
  drawSV();
}

function toggleColorPicker() {
  S.pickerOpen = !S.pickerOpen;
  if (S.pickerOpen) setFromHex(S.customColor);
  colorPanel.classList.toggle('show', S.pickerOpen);
  render();
  requestAnimationFrame(() => { layout(); drawSV(); });
}

let svDrag = false;
function pickSV(e) {
  const r = svArea.getBoundingClientRect();
  hsv.s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  hsv.v = 1 - Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
  applyPickedColor();
}
svArea.addEventListener('pointerdown', (e) => {
  svDrag = true;
  try { svArea.setPointerCapture(e.pointerId); } catch (_) { /* 무시 */ }
  pickSV(e); e.stopPropagation();
});
svArea.addEventListener('pointermove', (e) => { if (svDrag) { pickSV(e); e.stopPropagation(); } });
svArea.addEventListener('pointerup', (e) => { svDrag = false; render(); e.stopPropagation(); });
hueRange.addEventListener('input', () => { hsv.h = Number(hueRange.value); applyPickedColor(); });
hueRange.addEventListener('change', render);
colorPanel.addEventListener('pointerdown', (e) => e.stopPropagation());

/* ---------------- 핸들: 드래그 이동 + 탭으로 열기 ----------------
 * 드래그가 시작되면 툴바 창을 화면 전체로 한 번 키우고(메인 프로세스), 그 뒤로는
 * 창을 전혀 옮기지 않는다. 예전에는 포인터가 움직일 때마다 창을 옮겼는데, 창 이동이
 * 입력보다 늦게 반영되면서 위치가 앞뒤로 튀어 툴바가 부르르 떨렸다.
 * 터치는 이벤트가 훨씬 촘촘해서 전자칠판에서 특히 심했다. */
let drag = null;
let dragMode = false;
let dragFrame = 0;

function setDragMode(on) {
  if (dragMode === on) return;
  dragMode = on;
  window.pipen.setToolbarDragging(on);
}

handle.addEventListener('pointerdown', (e) => {
  try { handle.setPointerCapture(e.pointerId); } catch (_) { /* 무시 */ }
  drag = { sx: e.screenX, sy: e.screenY, ox: dockScreen.x, oy: dockScreen.y, moved: false };
  e.stopPropagation();
});
handle.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.screenX - drag.sx, dy = e.screenY - drag.sy;
  if (!drag.moved) {
    if (Math.abs(dx) <= 4 && Math.abs(dy) <= 4) return;   // 탭과 구분하기 위한 최소 이동량
    drag.moved = true;
    setDragMode(true);
  }
  dockScreen.x = drag.ox + dx;
  dockScreen.y = drag.oy + dy;
  clampDock();
  if (dragFrame) return;                                   // 한 프레임에 한 번만 배치
  dragFrame = requestAnimationFrame(() => { dragFrame = 0; layout(); });
});
/* 토글은 click 한 곳에서만 처리한다.
 * 이 창은 비활성 창(focusable:false)이라 탭/클릭 한 번이 포인터 이벤트 두 쌍으로
 * 들어오는 환경이 있는데, pointerup 에서 토글하면 두 번 뒤집혀 "안 눌리는" 것처럼 보인다. */
let lastToggle = 0;
let suppressClick = false;

function handleUp() {
  const d = drag;
  drag = null;                       // 어떤 경로로 끝나든 드래그 상태를 먼저 정리
  if (dragFrame) { cancelAnimationFrame(dragFrame); dragFrame = 0; }
  setDragMode(false);                // 창을 다시 UI 크기에 딱 맞춘다
  if (d && d.moved) { suppressClick = true; }
  render();
}
handle.addEventListener('pointerup', handleUp);
handle.addEventListener('pointercancel', handleUp);
// 창 크기가 바뀌면서 포인터 캡처가 풀릴 수 있다. 이때는 토글하지 않고 상태만 정리한다.
handle.addEventListener('lostpointercapture', () => {
  if (!drag) return;
  drag = null;
  if (dragFrame) { cancelAnimationFrame(dragFrame); dragFrame = 0; }
  setDragMode(false);
  render();
});

handle.addEventListener('click', (e) => {
  e.stopPropagation();
  if (suppressClick) { suppressClick = false; return; }   // 방금 드래그로 옮긴 경우
  const now = Date.now();
  if (now - lastToggle < 350) return;                     // 중복 전달 무시
  lastToggle = now;
  S.fanOpen = !S.fanOpen;
  render();
});

/* 어떤 이유로든 창 크기와 모델이 어긋나면 되돌린다 (접었다 폈다를 반복할 때 보험) */
setInterval(() => {
  if (drag || dragMode) return;
  layout();
}, 1500);

/* ---------------- 설정 저장 ---------------- */
const SAVED = ['tool', 'eraserMode', 'color', 'customColor', 'penSize', 'hiSize', 'eraserSize',
  'touchWrite', 'palmErase', 'palmThreshold'];

function saveSettings() {
  try {
    const o = {};
    for (const k of SAVED) o[k] = S[k];
    o.dockX = dockScreen.x; o.dockY = dockScreen.y;
    localStorage.setItem('pipen-settings', JSON.stringify(o));
  } catch (_) { /* 저장 실패는 무시 */ }
}
function loadSettings() {
  try {
    const o = JSON.parse(localStorage.getItem('pipen-settings') || '{}');
    for (const k of SAVED) if (o[k] !== undefined) S[k] = o[k];
    if (S.tool === 'mouse') S.tool = 'pen';
    if (typeof o.dockX === 'number') dockScreen = { x: o.dockX, y: o.dockY };
  } catch (_) { /* 손상된 설정은 기본값 */ }
}

/* ---------------- 단축키 / 오버레이 메시지 ---------------- */
window.pipen.onShortcut((name) => {
  if (name === 'toggle-mode') setTool(S.tool === 'mouse' ? 'pen' : 'mouse');
  else if (name === 'clear') sendCmd('clear');
  else if (name === 'undo') sendCmd('undo');
  else if (name === 'redo') sendCmd('redo');
  else if (name === 'resize') render();
});

window.pipen.onFromOverlay((m) => {
  if (m.touchSize !== undefined) {
    S.lastTouchSize = m.touchSize;
    if (m.sizeReported !== undefined) S.touchSizeReported = m.sizeReported;
    if (S.submenu === 'settings') updateSlider();
  }
});

/* ---------------- 시작 ---------------- */
loadSettings();
S.submenu = submenuForTool();
setFromHex(S.customColor);
render();
pushState();
toast('Alt+P 펜/마우스 · Alt+Z 실행취소 · Alt+X 전체지움');
