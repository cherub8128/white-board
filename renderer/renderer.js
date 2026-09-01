/* ============================================================
 *  Whiteboard Pen - renderer
 *  - 멀티 포인터(펜 2개 동시 필기) 지원
 *  - 팜(넓은 접촉) 자동 지우개
 *  - 지우개: 획 / 영역 / 전체
 *  - 화면 고정 <-> 화면 통과(아래 화면 조작) 전환
 * ========================================================== */

const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d', { desynchronized: true });

const dock = document.getElementById('dock');
const fan = document.getElementById('fan');
const fanPanel = document.getElementById('fanPanel');
const handle = document.getElementById('handle');
const pod = document.getElementById('slider');
const sizeRange = document.getElementById('sizeRange');
const sizeValue = document.getElementById('sizeValue');
const sizeLabel = document.getElementById('sizeLabel');
const sizeDot = document.getElementById('sizeDot');
const toastEl = document.getElementById('toast');

/* ---------------- 상태 ---------------- */
const COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#ffffff', '#1c1c1e'];

const S = {
  tool: 'pen',              // pen | highlighter | eraser | mouse
  eraserMode: 'stroke',     // stroke | area | all
  color: '#ff3b30',
  customColor: '#8a4dff',   // 기타 색(RGB 패널에서 고른 색)
  pickerOpen: false,
  penSize: 6,
  hiSize: 24,
  eraserSize: 40,
  screenLock: true,         // true=화면 고정(필기), false=화면 통과(아래 화면 조작)
  touchWrite: true,         // 손가락 터치로 필기
  palmErase: true,          // 넓은 접촉 = 지우개
  palmThreshold: 90,        // px, 접촉 폭이 이 이상이면 팜으로 판단 (설정에서 보정)
  lastTouchSize: 0,         // 마지막 터치 접촉 크기 (보정용 표시)
  fanOpen: false,
  modalOpen: false,
  submenu: null             // 'color' | 'eraser' | 'settings' | null
};

let strokes = [];   // {id, tool, color, size, alpha, comp, pts:[{x,y,p}], gone:false}
let history = [];   // {kind:'draw'|'erase'|'clear', id?, ids?}
let redoStack = [];
let strokeSeq = 0;
const active = new Map();  // pointerId -> stroke state

/* ---------------- 캔버스 ---------------- */
let dpr = 1;
function resizeCanvas() {
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  redrawAll();
}
window.addEventListener('resize', () => {
  resizeCanvas();
  render();          // 화면 크기가 바뀌면 부채꼴 방향도 다시 계산
});

function widthAt(st, p) {
  if (st.tool === 'pen') return Math.max(0.6, st.size * (0.45 + 1.1 * (p.p === undefined ? 0.5 : p.p)));
  return st.size;
}

/* 중점 보간(quadratic)으로 매끄럽게 + 세그먼트별 두께 */
function drawStroke(st, upto) {
  const pts = st.pts;
  const n = (upto === undefined ? pts.length : upto);
  if (n === 0) return;

  ctx.save();
  ctx.globalCompositeOperation = st.comp;
  ctx.globalAlpha = st.alpha;
  ctx.strokeStyle = st.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (n === 1) {
    ctx.beginPath();
    ctx.fillStyle = st.color;
    ctx.arc(pts[0].x, pts[0].y, widthAt(st, pts[0]) / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  const start = (upto === undefined) ? 1 : n - 1;
  for (let i = Math.max(1, start); i < n; i++) {
    const a = pts[i - 1], b = pts[i];
    const prev = pts[i - 2] || a;
    const m0 = { x: (prev.x + a.x) / 2, y: (prev.y + a.y) / 2 };
    const m1 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    ctx.beginPath();
    ctx.lineWidth = (widthAt(st, a) + widthAt(st, b)) / 2;
    ctx.moveTo(m0.x, m0.y);
    ctx.quadraticCurveTo(a.x, a.y, m1.x, m1.y);
    if (i === n - 1) ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.restore();
}

function redrawAll() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const st of strokes) if (!st.gone) drawStroke(st);
  for (const a of active.values()) if (a.stroke) drawStroke(a.stroke);
}

/* ---------------- 입력 ---------------- */
function captureInput() { return S.tool !== 'mouse' && S.screenLock; }

function isPalm(e) {
  if (e.pointerType !== 'touch') return false;
  const c = Math.max(e.width || 0, e.height || 0);
  if (c > 0) {
    S.lastTouchSize = Math.round(c);
    if (S.submenu === 'settings') updateSlider();   // 보정 중이면 실측값 표시
  }
  if (!S.palmErase) return false;
  return c >= S.palmThreshold;
}

function makeStroke(kind, e) {
  const id = ++strokeSeq;
  if (kind === 'eraseArea') {
    const c = Math.max(e.width || 0, e.height || 0);
    const size = (e.pointerType === 'touch' && c > 0)
      ? Math.max(S.eraserSize, c * 1.6) : S.eraserSize;
    return { id, tool: 'eraser', color: '#000', size, alpha: 1, comp: 'destination-out', pts: [], gone: false };
  }
  if (kind === 'highlighter')
    return { id, tool: 'highlighter', color: S.color, size: S.hiSize, alpha: 0.32, comp: 'source-over', pts: [], gone: false };
  return { id, tool: 'pen', color: S.color, size: S.penSize, alpha: 1, comp: 'source-over', pts: [], gone: false };
}

function pointOf(e) {
  return { x: e.clientX, y: e.clientY, p: e.pressure > 0 ? e.pressure : 0.5 };
}

canvas.addEventListener('pointerdown', (e) => {
  if (!captureInput()) return;
  const palm = isPalm(e);
  if (e.pointerType === 'touch' && !S.touchWrite && !palm) return;

  canvas.setPointerCapture(e.pointerId);
  e.preventDefault();

  let kind;
  if (palm) kind = 'eraseArea';
  else if (S.tool === 'eraser') kind = (S.eraserMode === 'stroke') ? 'eraseStroke' : 'eraseArea';
  else kind = S.tool;

  if (kind === 'eraseStroke') {
    const removed = [];
    active.set(e.pointerId, { kind, removed, stroke: null });
    eraseStrokeAt(pointOf(e), removed);
    return;
  }

  const stroke = makeStroke(kind, e);
  stroke.pts.push(pointOf(e));
  active.set(e.pointerId, { kind, stroke });
  drawStroke(stroke);
}, { passive: false });

canvas.addEventListener('pointermove', (e) => {
  const a = active.get(e.pointerId);
  if (!a) return;
  e.preventDefault();

  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];

  if (a.kind === 'eraseStroke') {
    for (const ev of events) eraseStrokeAt(pointOf(ev), a.removed);
    return;
  }

  const st = a.stroke;
  for (const ev of events) {
    const p = pointOf(ev);
    const last = st.pts[st.pts.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) < 0.7) continue;
    st.pts.push(p);
    drawStroke(st, st.pts.length);
  }
}, { passive: false });

function endPointer(e) {
  const a = active.get(e.pointerId);
  if (!a) return;
  active.delete(e.pointerId);

  if (a.kind === 'eraseStroke') {
    if (a.removed.length) { history.push({ kind: 'erase', ids: a.removed.slice() }); redoStack = []; }
    return;
  }
  const st = a.stroke;
  if (!st || st.pts.length === 0) return;
  strokes.push(st);
  history.push({ kind: 'draw', id: st.id });
  redoStack = [];
  redrawAll();
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

/* 획 단위 지우기 */
function eraseStrokeAt(p, removedOut) {
  const r = 12;
  let hit = false;
  for (let i = strokes.length - 1; i >= 0; i--) {
    const st = strokes[i];
    if (st.gone || st.comp === 'destination-out') continue;
    if (hitStroke(st, p, r + st.size / 2)) {
      st.gone = true;
      removedOut.push(st.id);
      hit = true;
    }
  }
  if (hit) redrawAll();
}

function hitStroke(st, p, tol) {
  const pts = st.pts;
  if (pts.length === 1) return Math.hypot(pts[0].x - p.x, pts[0].y - p.y) <= tol;
  for (let i = 1; i < pts.length; i++) {
    if (distToSeg(p, pts[i - 1], pts[i]) <= tol) return true;
  }
  return false;
}
function distToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/* ---------------- 되돌리기 / 다시실행 / 전체 지우기 ---------------- */
function findStroke(id) { return strokes.find(s => s.id === id); }

function undo() {
  const op = history.pop();
  if (!op) { toast('되돌릴 작업이 없습니다'); return; }
  if (op.kind === 'draw') { const s = findStroke(op.id); if (s) s.gone = true; }
  else { for (const id of op.ids) { const s = findStroke(id); if (s) s.gone = false; } }
  redoStack.push(op); redrawAll();
}
function redo() {
  const op = redoStack.pop();
  if (!op) { toast('다시 실행할 작업이 없습니다'); return; }
  if (op.kind === 'draw') { const s = findStroke(op.id); if (s) s.gone = false; }
  else { for (const id of op.ids) { const s = findStroke(id); if (s) s.gone = true; } }
  history.push(op); redrawAll();
}
function clearAll() {
  const ids = strokes.filter(s => !s.gone).map(s => s.id);
  if (!ids.length) { toast('지울 내용이 없습니다'); return; }
  for (const id of ids) findStroke(id).gone = true;
  history.push({ kind: 'clear', ids }); redoStack = [];
  redrawAll(); toast('전체 지움');
}

/* ---------------- 툴바 (부채꼴) ---------------- */
const ICON = {
  pen: '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M3 21l3.6-1 11-11a2.1 2.1 0 0 0-3-3l-11 11L3 21z" fill="currentColor"/></svg>',
  hi: '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M5 17l-1 4 4-1 10-10-3-3L5 17z" fill="currentColor" opacity=".9"/><rect x="3" y="21" width="18" height="2" rx="1" fill="currentColor"/></svg>',
  eraser: '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M6 18l-3-3a2 2 0 0 1 0-3l8-8a2 2 0 0 1 3 0l5 5a2 2 0 0 1 0 3l-6 6H6z" fill="currentColor"/><rect x="3" y="20" width="18" height="2" rx="1" fill="currentColor" opacity=".6"/></svg>',
  mouse: '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M5 3l14 8-6 1.4L10 20 5 3z" fill="currentColor"/></svg>',
  undo: '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M9 7h5a6 6 0 0 1 0 12h-4v-2h4a4 4 0 0 0 0-8H9v3L4 8l5-4v3z" fill="currentColor"/></svg>',
  redo: '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M15 7h-5a6 6 0 0 0 0 12h4v-2h-4a4 4 0 0 1 0-8h5v3l5-4-5-4v3z" fill="currentColor"/></svg>',
  gear: '<svg viewBox="0 0 24 24" width="26" height="26"><path fill-rule="evenodd" d="M19.49 10.2 L22.27 10.37 L22.27 13.63 L19.49 13.8 L18.57 16.02 L20.41 18.11 L18.11 20.41 L16.02 18.57 L13.8 19.49 L13.63 22.27 L10.37 22.27 L10.2 19.49 L7.98 18.57 L5.89 20.41 L3.59 18.11 L5.43 16.02 L4.51 13.8 L1.73 13.63 L1.73 10.37 L4.51 10.2 L5.43 7.98 L3.59 5.89 L5.89 3.59 L7.98 5.43 L10.2 4.51 L10.37 1.73 L13.63 1.73 L13.8 4.51 L16.02 5.43 L18.11 3.59 L20.41 5.89 L18.57 7.98 Z M8.5 12 A 3.5 3.5 0 1 0 15.5 12 A 3.5 3.5 0 1 0 8.5 12 Z" fill="currentColor"/></svg>',
  info: '<svg viewBox="0 0 24 24" width="26" height="26"><circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" stroke-width="1.9"/><circle cx="12" cy="7.6" r="1.25" fill="currentColor"/><rect x="11" y="10.4" width="2" height="7" rx="1" fill="currentColor"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>'
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
    item('undo', ICON.undo, '실행취소', undo),
    item('redo', ICON.redo, '다시실행', redo),
    item('settings', ICON.gear, '설정', () => toggleSubmenu('settings'))
  ];
}

function ring2() {
  if (S.submenu === 'color') {
    const swatches = COLORS.map(c => item('c' + c, '<i style="background:' + c + '"></i>', '', () => {
      S.color = c; S.pickerOpen = false; render();
    }, { cls: 'color', activeIf: () => S.color === c }));
    swatches.push(item('custom',
      '<i style="background:conic-gradient(#ff3b30,#ffcc00,#34c759,#0ad,#4c8dff,#b45cff,#ff3b30);' +
      'box-shadow:inset 0 0 0 2px ' + S.customColor + '"></i>',
      '기타 색 (RGB 선택)', toggleColorPicker,
      { cls: 'color', activeIf: () => S.pickerOpen || S.color === S.customColor }));
    return swatches;
  }

  if (S.submenu === 'eraser')
    return [
      item('e-stroke', '<span class="lbl">획<br>지우기</span>', '획 단위로 지우기',
        () => { S.eraserMode = 'stroke'; render(); }, { activeIf: () => S.eraserMode === 'stroke' }),
      item('e-area', '<span class="lbl">영역<br>지우기</span>', '문지른 영역만 지우기',
        () => { S.eraserMode = 'area'; render(); }, { activeIf: () => S.eraserMode === 'area' }),
      item('e-all', '<span class="lbl">전체<br>지우기</span>', '모두 지우기', clearAll)
    ];

  if (S.submenu === 'settings')
    return [
      item('lock', '<span class="lbl">' + (S.screenLock ? '화면<br>고정' : '화면<br>통과') + '</span>',
        '화면 고정 / 아래 화면 조작', () => setScreenLock(!S.screenLock), { toggle: () => S.screenLock }),
      item('touch', '<span class="lbl">터치<br>필기</span>', '손가락 필기 켜기/끄기',
        () => { S.touchWrite = !S.touchWrite; render(); toast('터치 필기 ' + (S.touchWrite ? '켜짐' : '꺼짐')); },
        { toggle: () => S.touchWrite }),
      item('palm', '<span class="lbl">팜<br>지우기</span>', '손바닥으로 지우기',
        () => { S.palmErase = !S.palmErase; render(); toast('팜 지우기 ' + (S.palmErase ? '켜짐' : '꺼짐')); },
        { toggle: () => S.palmErase }),
      item('info', ICON.info, '정보 · 업데이트', showInfo),
      item('quit', ICON.close, '종료', () => window.overlay.quit())
    ];
  return [];
}

function arcAngles(count, centerDeg, spreadDeg) {
  if (count === 1) return [centerDeg];
  const step = spreadDeg / (count - 1);
  return Array.from({ length: count }, (_, i) => centerDeg - spreadDeg / 2 + i * step);
}

function render() {
  fan.innerHTML = '';
  fan.classList.toggle('open', S.fanOpen);
  fanPanel.classList.toggle('open', S.fanOpen);
  handle.classList.toggle('open', S.fanOpen);
  handle.classList.toggle('mouse-mode', S.tool === 'mouse' || !S.screenLock);
  if (!S.fanOpen) { pod.classList.remove('show'); return; }

  const dir = dockDirection();
  clampDock(dir);
  for (const d of ['right', 'left', 'up', 'down']) dock.classList.toggle('dir-' + d, d === dir);
  const center = { right: 0, left: 180, down: 90, up: -90 }[dir];

  const r1 = ring1(), r2 = ring2();
  place(r1, 101, arcAngles(r1.length, center, 142));
  if (r2.length) place(r2, 157, arcAngles(r2.length, center, 120));

  updateSlider();
  layoutPanels(dir);
  saveSettings();
}

/* 핸들 위치로 부착 방향 결정 — 화면 위/아래 가장자리에 가까우면 회전시켜 붙인다 */
const EDGE = 150;
function dockDirection() {
  const x = dock.offsetLeft, y = dock.offsetTop;
  if (y < EDGE) return 'down';
  if (window.innerHeight - y < EDGE) return 'up';
  return x < window.innerWidth / 2 ? 'right' : 'left';
}

/* 반원이 화면 밖으로 나가지 않도록 핸들 위치를 제한한다 */
function clampDock(dir) {
  const R = PANEL_R + 8;
  const cl = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  if (dir === 'up' || dir === 'down') {
    dock.style.left = cl(dock.offsetLeft, R, window.innerWidth - R) + 'px';
  } else {
    dock.style.top = cl(dock.offsetTop, R, window.innerHeight - R) + 'px';
  }
}

/* 두께·색상 패널을 부채꼴에 붙여 배치한다 (부채꼴 폭과 같은 너비) */
const PANEL_R = 194, PANEL_GAP = 10;
function layoutPanels(dir) {
  const w = PANEL_R;
  let x, y;

  if (dir === 'right' || dir === 'left') {
    // 반원 아래에 세로로 붙인다
    x = (dir === 'right') ? 0 : -PANEL_R;
    y = PANEL_R + PANEL_GAP;
  } else {
    // 위/아래 가장자리에 붙었을 때는 반원 오른쪽에 나란히 둔다
    x = PANEL_R + PANEL_GAP;
    y = (dir === 'down') ? 0 : -PANEL_R;
    if (dock.offsetLeft + x + w > window.innerWidth - 12) x = -PANEL_R - PANEL_GAP - w;
  }

  for (const el of [pod, colorPanel]) {
    el.style.width = w + 'px';
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    if (el.classList.contains('show')) y += el.offsetHeight + PANEL_GAP;
  }

  // 아래로 넘치면 위쪽으로 접어 올린다
  if (dir === 'right' || dir === 'left') {
    const overflow = dock.offsetTop + y - (window.innerHeight - 12);
    if (overflow > 0) {
      for (const el of [pod, colorPanel]) {
        el.style.top = (parseFloat(el.style.top) - overflow) + 'px';
      }
    }
  }
  if (S.pickerOpen) drawSV();
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

function setTool(t) {
  S.tool = t;
  if (t !== 'pen' && t !== 'highlighter') {
    S.pickerOpen = false;
    colorPanel.classList.remove('show');
  }
  S.submenu = submenuForTool();
  if (t === 'mouse') toast('마우스 모드 — 아래 화면을 그대로 조작합니다');
  applyMode();
  render();
}

function submenuForTool() {
  if (S.tool === 'pen' || S.tool === 'highlighter') return 'color';
  if (S.tool === 'eraser') return 'eraser';
  return null;
}

function toggleSubmenu(name) {
  // 설정을 다시 누르면 메뉴가 사라지지 않고 현재 도구의 하위 메뉴로 돌아온다
  S.submenu = (S.submenu === name) ? submenuForTool() : name;
  render();
}

function setScreenLock(lock) {
  S.screenLock = lock;
  applyMode();
  render();
  toast(lock ? '화면 고정 — 필기 가능' : '화면 통과 — 아래 화면을 조작할 수 있습니다 (필기 내용은 유지)');
}

function applyMode() {
  if (S.modalOpen) return;                  // 모달이 떠 있는 동안은 통과시키지 않음
  const cap = captureInput();
  canvas.style.pointerEvents = cap ? 'auto' : 'none';
  overDock = false;
  window.overlay.setClickThrough(!cap);
}

/* 통과 모드에서 툴바 위에 커서가 오면 잠깐 통과 해제 */
let overDock = false;
document.addEventListener('mousemove', (e) => {
  if (captureInput() || S.modalOpen) return;
  const inside = overUI(e.clientX, e.clientY);
  if (inside !== overDock) {
    overDock = inside;
    window.overlay.setClickThrough(!inside);
  }
});
function overUI(x, y) {
  const hit = (el) => {
    const r = el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };
  if (hit(handle)) return true;
  if (S.fanOpen && hit(fanPanel)) return true;
  for (const el of [pod, colorPanel]) if (el.classList.contains('show') && hit(el)) return true;
  return false;
}

/* ---------------- 두께 슬라이더 ---------------- */
function currentSizeKey() {
  if (S.submenu === 'settings') return 'palmThreshold';
  if (S.tool === 'pen') return 'penSize';
  if (S.tool === 'highlighter') return 'hiSize';
  if (S.tool === 'eraser' && S.eraserMode === 'area') return 'eraserSize';
  return null;
}
const SLIDER_MAX = { penSize: 40, hiSize: 80, eraserSize: 160, palmThreshold: 220 };
const SLIDER_MIN = { penSize: 1, hiSize: 4, eraserSize: 8, palmThreshold: 30 };

function updateSlider() {
  const key = currentSizeKey();
  if (!S.fanOpen || !key) { pod.classList.remove('show'); return; }
  pod.classList.add('show');

  sizeRange.min = SLIDER_MIN[key];
  sizeRange.max = SLIDER_MAX[key];
  sizeRange.value = S[key];

  if (key === 'palmThreshold') {
    // 값이 클수록 손가락이 지우개로 오인될 확률이 낮아짐
    sizeLabel.textContent = '팜 인식 크기 (측정: ' + (S.lastTouchSize || '-') + ')';
    sizeValue.textContent = S[key];
    const d = Math.min(30, Math.max(4, S[key] / 6));
    sizeDot.style.width = d + 'px';
    sizeDot.style.height = d + 'px';
    sizeDot.style.background = '#9aa1ad';
    sizeDot.style.opacity = 1;
  } else {
    sizeLabel.textContent = (key === 'eraserSize') ? '지우개 크기' : '두께';
    sizeValue.textContent = S[key];
    const d = Math.min(30, Math.max(3, S[key]));
    sizeDot.style.width = d + 'px';
    sizeDot.style.height = d + 'px';
    sizeDot.style.background = (key === 'eraserSize') ? '#9aa1ad' : S.color;
    sizeDot.style.opacity = (key === 'hiSize') ? 0.5 : 1;
  }
}
sizeRange.addEventListener('input', () => {
  const key = currentSizeKey(); if (!key) return;
  S[key] = Number(sizeRange.value);
  updateSlider();
  saveSettings();
});
pod.addEventListener('pointerdown', (e) => e.stopPropagation());

/* ---------------- 핸들: 드래그 이동 + 탭으로 열기 ---------------- */
let drag = null;
handle.addEventListener('pointerdown', (e) => {
  handle.setPointerCapture(e.pointerId);
  drag = { sx: e.clientX, sy: e.clientY, ox: dock.offsetLeft, oy: dock.offsetTop, moved: false };
  e.stopPropagation();
});
handle.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
  if (Math.abs(dx) > 4 || Math.abs(dy) > 4) drag.moved = true;
  if (!drag.moved) return;
  dock.style.left = Math.min(window.innerWidth - 40, Math.max(40, drag.ox + dx)) + 'px';
  dock.style.top = Math.min(window.innerHeight - 40, Math.max(40, drag.oy + dy)) + 'px';
  if (S.fanOpen) render();
});
function handleUp(e) {
  if (drag && !drag.moved) { S.fanOpen = !S.fanOpen; render(); }
  drag = null;
  e.stopPropagation();
}
handle.addEventListener('pointerup', handleUp);
handle.addEventListener('pointercancel', handleUp);

/* ---------------- 단축키 / 토스트 ---------------- */
window.overlay.onShortcut((name) => {
  if (name === 'toggle-mode') setTool(S.tool === 'mouse' ? 'pen' : 'mouse');
  else if (name === 'clear') clearAll();
  else if (name === 'undo') undo();
  else if (name === 'redo') redo();
  else if (name === 'resize') resizeCanvas();
});
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (e.ctrlKey && k === 'z') { e.preventDefault(); undo(); }
  if (e.ctrlKey && k === 'y') { e.preventDefault(); redo(); }
  if (e.key === 'Escape') { if (S.modalOpen) closeModal(); else { S.fanOpen = false; render(); } }
});

/* ---------------- RGB 색 선택 패널 ---------------- */
const colorPanel = document.getElementById('colorPanel');
const svArea = document.getElementById('svArea');
const svCtx = svArea.getContext('2d');
const hueRange = document.getElementById('hueRange');
const colorSwatch = document.getElementById('colorSwatch');
const colorHex = document.getElementById('colorHex');

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
function hex(rgb) {
  return '#' + rgb.map(n => n.toString(16).padStart(2, '0')).join('').toUpperCase();
}
function hex2rgb(h) {
  const m = /^#?([0-9a-f]{6})$/i.exec(h);
  if (!m) return [255, 59, 48];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function drawSV() {
  const cssW = svArea.clientWidth || 208, cssH = svArea.clientHeight || 104;
  if (svArea.width !== cssW || svArea.height !== cssH) {
    svArea.width = cssW; svArea.height = cssH;
  }
  const w = svArea.width, h = svArea.height;
  const base = hsv2rgb(hsv.h, 1, 1);
  svCtx.fillStyle = 'rgb(' + base.join(',') + ')';
  svCtx.fillRect(0, 0, w, h);

  const white = svCtx.createLinearGradient(0, 0, w, 0);
  white.addColorStop(0, 'rgba(255,255,255,1)');
  white.addColorStop(1, 'rgba(255,255,255,0)');
  svCtx.fillStyle = white; svCtx.fillRect(0, 0, w, h);

  const black = svCtx.createLinearGradient(0, 0, 0, h);
  black.addColorStop(0, 'rgba(0,0,0,0)');
  black.addColorStop(1, 'rgba(0,0,0,1)');
  svCtx.fillStyle = black; svCtx.fillRect(0, 0, w, h);

  // 현재 위치 표시
  const x = hsv.s * w, y = (1 - hsv.v) * h;
  svCtx.beginPath();
  svCtx.arc(x, y, 7, 0, Math.PI * 2);
  svCtx.strokeStyle = 'rgba(0,0,0,.55)'; svCtx.lineWidth = 3; svCtx.stroke();
  svCtx.strokeStyle = '#fff'; svCtx.lineWidth = 2; svCtx.stroke();
}

function applyPickedColor() {
  const rgb = hsv2rgb(hsv.h, hsv.s, hsv.v);
  const h = hex(rgb);
  S.customColor = h;
  S.color = h;
  colorSwatch.style.background = h;
  colorHex.textContent = h;
  drawSV();
}

function setFromHex(h) {
  const [r, g, b] = hex2rgb(h);
  hsv = rgb2hsv(r, g, b);
  hueRange.value = Math.round(hsv.h);
  applyPickedColor();
}

function toggleColorPicker() {
  S.pickerOpen = !S.pickerOpen;
  if (S.pickerOpen) setFromHex(S.customColor);
  colorPanel.classList.toggle('show', S.pickerOpen);
  render();
  requestAnimationFrame(() => { layoutPanels(dockDirection()); drawSV(); });
}

let svDrag = false;
function pickSV(e) {
  const r = svArea.getBoundingClientRect();
  hsv.s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  hsv.v = 1 - Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
  applyPickedColor();
}
svArea.addEventListener('pointerdown', (e) => {
  svDrag = true; svArea.setPointerCapture(e.pointerId); pickSV(e); e.stopPropagation();
});
svArea.addEventListener('pointermove', (e) => { if (svDrag) { pickSV(e); e.stopPropagation(); } });
svArea.addEventListener('pointerup', (e) => { svDrag = false; render(); e.stopPropagation(); });
hueRange.addEventListener('input', () => { hsv.h = Number(hueRange.value); applyPickedColor(); });
hueRange.addEventListener('change', render);
colorPanel.addEventListener('pointerdown', (e) => e.stopPropagation());

/* ---------------- 모달 (정보 / 업데이트) ---------------- */
const modal = document.getElementById('modal');
const modalTitle = document.getElementById('modalTitle');
const modalBody = document.getElementById('modalBody');
const modalActions = document.getElementById('modalActions');
let appInfo = { version: '-', homepage: '#', releases: '#', repo: '#' };

function openModal(title, bodyHtml, actions) {
  modalTitle.textContent = title;
  modalBody.innerHTML = bodyHtml;
  modalActions.innerHTML = '';
  for (const a of actions) {
    const b = document.createElement('button');
    b.textContent = a.label;
    if (a.primary) b.className = 'primary';
    b.addEventListener('click', () => { closeModal(); if (a.onclick) a.onclick(); });
    modalActions.appendChild(b);
  }
  modalBody.querySelectorAll('a[data-url]').forEach(el => {
    el.addEventListener('click', (e) => { e.preventDefault(); window.overlay.openExternal(el.dataset.url); });
  });
  S.modalOpen = true;
  modal.classList.add('show');
  window.overlay.setClickThrough(false);   // 모달은 항상 클릭 가능해야 함
}

function closeModal() {
  S.modalOpen = false;
  modal.classList.remove('show');
  applyMode();
}
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

function showInfo() {
  const body =
    '<div class="row"><span>버전</span><b>v' + appInfo.version + '</b></div>' +
    '<div class="row"><span>제작</span><a data-url="' + appInfo.homepage + '" href="#">pi-dimension.com</a></div>' +
    '<div class="row"><span>릴리즈</span><a data-url="' + appInfo.releases + '" href="#">github.com/cherub8128/white-board</a></div>' +
    '<div class="row"><span>라이선스</span><b>MIT</b></div>';
  openModal('판서 (WhiteboardPen)', body, [
    { label: '업데이트 확인', onclick: () => { toast('업데이트를 확인하는 중...'); window.overlay.checkUpdate(); } },
    { label: '닫기', primary: true }
  ]);
}

window.overlay.getInfo().then((i) => { appInfo = i; });

window.overlay.onUpdateAvailable((info) => {
  const notes = info.notes ? '<div class="notes">' + escapeHtml(info.notes.slice(0, 800)) + '</div>' : '';
  openModal('새 버전이 있습니다', 
    '<div class="row"><span>현재 버전</span><b>v' + info.current + '</b></div>' +
    '<div class="row"><span>최신 버전</span><b style="color:#6fa8ff">v' + info.latest + '</b></div>' + notes,
    [
      { label: '나중에' },
      { label: '다운로드', primary: true, onclick: () => window.overlay.openExternal(appInfo.releases) }
    ]);
});

window.overlay.onUpdateNone((info) => {
  toast(info.failed ? '업데이트 정보를 가져오지 못했습니다' : '최신 버전입니다 (v' + info.current + ')');
});

function escapeHtml(t) {
  return t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1800);
}

/* ---------------- 설정 저장 ---------------- */
const SAVED_KEYS = ['tool', 'eraserMode', 'color', 'penSize', 'hiSize', 'eraserSize',
  'touchWrite', 'palmErase', 'palmThreshold', 'customColor'];

function saveSettings() {
  try {
    const o = {};
    for (const k of SAVED_KEYS) o[k] = S[k];
    o.dockLeft = dock.offsetLeft; o.dockTop = dock.offsetTop;
    localStorage.setItem('wb-settings', JSON.stringify(o));
  } catch (_) { /* 저장 실패는 무시 */ }
}
function loadSettings() {
  try {
    const o = JSON.parse(localStorage.getItem('wb-settings') || '{}');
    for (const k of SAVED_KEYS) if (o[k] !== undefined) S[k] = o[k];
    if (S.tool === 'mouse') S.tool = 'pen';        // 항상 펜으로 시작
    if (typeof o.dockLeft === 'number') {
      dock.style.left = Math.min(window.innerWidth - 40, Math.max(40, o.dockLeft)) + 'px';
      dock.style.top = Math.min(window.innerHeight - 40, Math.max(40, o.dockTop)) + 'px';
    }
  } catch (_) { /* 손상된 설정은 기본값 사용 */ }
}

/* ---------------- 시작 ---------------- */
loadSettings();
resizeCanvas();
const savedColor = S.color;
setFromHex(S.customColor);      // 선택기 UI를 저장된 커스텀 색으로 맞춘다
S.color = savedColor;
setTool(S.tool);
S.fanOpen = true;
render();
toast('Alt+P 펜/마우스 · Alt+Z 실행취소 · Alt+X 전체지움');
