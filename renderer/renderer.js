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
window.addEventListener('resize', resizeCanvas);

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
  pen: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M3 21l3.6-1 11-11a2.1 2.1 0 0 0-3-3l-11 11L3 21z" fill="currentColor"/></svg>',
  hi: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M5 17l-1 4 4-1 10-10-3-3L5 17z" fill="currentColor" opacity=".9"/><rect x="3" y="21" width="18" height="2" rx="1" fill="currentColor"/></svg>',
  eraser: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M6 18l-3-3a2 2 0 0 1 0-3l8-8a2 2 0 0 1 3 0l5 5a2 2 0 0 1 0 3l-6 6H6z" fill="currentColor"/><rect x="3" y="20" width="18" height="2" rx="1" fill="currentColor" opacity=".6"/></svg>',
  mouse: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M5 3l14 8-6 1.4L10 20 5 3z" fill="currentColor"/></svg>',
  undo: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M9 7h5a6 6 0 0 1 0 12h-4v-2h4a4 4 0 0 0 0-8H9v3L4 8l5-4v3z" fill="currentColor"/></svg>',
  redo: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M15 7h-5a6 6 0 0 0 0 12h4v-2h-4a4 4 0 0 1 0-8h5v3l5-4-5-4v3z" fill="currentColor"/></svg>',
  gear: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zm9.4 4.9l-2 1.2.3 2.3-2.2 1.3-1.8-1.5-2.2.9-.7 2.9h-2.6l-.7-2.9-2.2-.9-1.8 1.5-2.2-1.3.3-2.3-2-1.2v-2.6l2-1.2-.3-2.3 2.2-1.3 1.8 1.5 2.2-.9.7-2.9h2.6l.7 2.9 2.2.9 1.8-1.5 2.2 1.3-.3 2.3 2 1.2z" fill="currentColor"/></svg>',
  info: '<svg viewBox="0 0 24 24" width="22" height="22"><circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" stroke-width="1.9"/><circle cx="12" cy="7.6" r="1.25" fill="currentColor"/><rect x="11" y="10.4" width="2" height="7" rx="1" fill="currentColor"/></svg>',
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
  if (S.submenu === 'color')
    return COLORS.map(c => item('c' + c, '<i style="background:' + c + '"></i>', '', () => {
      S.color = c; render();
    }, { cls: 'color', activeIf: () => S.color === c }));

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
  handle.classList.toggle('open', S.fanOpen);
  handle.classList.toggle('mouse-mode', S.tool === 'mouse' || !S.screenLock);
  if (!S.fanOpen) { pod.classList.remove('show'); return; }

  const toRight = dock.offsetLeft < window.innerWidth / 2;
  const center = toRight ? 0 : 180;

  const r1 = ring1(), r2 = ring2();
  place(r1, 108, arcAngles(r1.length, center, 150));
  if (r2.length) place(r2, 180, arcAngles(r2.length, center, 124));

  updateSlider();
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

function setTool(t) {
  S.tool = t;
  if (t === 'pen' || t === 'highlighter') S.submenu = 'color';
  else if (t === 'eraser') S.submenu = 'eraser';
  else S.submenu = null;
  if (t === 'mouse') toast('마우스 모드 — 아래 화면을 그대로 조작합니다');
  applyMode();
  render();
}

function toggleSubmenu(name) {
  S.submenu = (S.submenu === name) ? null : name;
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
  const r = dockHitRect();
  const inside = e.clientX >= r.l && e.clientX <= r.r && e.clientY >= r.t && e.clientY <= r.b;
  if (inside !== overDock) {
    overDock = inside;
    window.overlay.setClickThrough(!inside);
  }
});
function dockHitRect() {
  const pad = S.fanOpen ? 240 : 46;
  return {
    l: dock.offsetLeft - pad, r: dock.offsetLeft + pad,
    t: dock.offsetTop - pad, b: dock.offsetTop + pad
  };
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
  const toRight = dock.offsetLeft < window.innerWidth / 2;
  pod.style.left = (toRight ? 96 : -306) + 'px';
  pod.style.top = '-160px';
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
  'touchWrite', 'palmErase', 'palmThreshold'];

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
setTool(S.tool);
S.fanOpen = true;
render();
toast('Alt+P 펜/마우스 · Alt+Z 실행취소 · Alt+X 전체지움');
