/* ============================================================
 *  Pi Pen — 오버레이 창 (그리기 전담)
 *  도구 상태는 툴바 창에서 IPC 로 받아 적용한다.
 *
 *  레이어를 둘로 나눈 이유:
 *  예전에는 캔버스 하나에 "확정된 그림 전체 + 그리는 중인 획"을 매 프레임 다시
 *  합성했다. 전체화면 크기의 이미지를 초당 60번 복사하는 셈이라, 전자칠판처럼
 *  해상도가 크고 GPU 가 약한 기기에서는 펜이 밀리고, 그 부하 때문에 아래 화면의
 *  애니메이션까지 끊겼다. 지금은 확정된 그림(base)은 획이 끝날 때만 그리고,
 *  그리는 중인 획(live)만 매 프레임 "새로 늘어난 부분"을 이어 그린다.
 * ========================================================== */

const base = document.getElementById('board');   // 확정된 획 (거의 안 건드린다)
const live = document.getElementById('live');    // 그리는 중인 획 + 입력 수신
const bctx = base.getContext('2d');
const lctx = live.getContext('2d', { desynchronized: true });

/* ---------------- 도구 상태 (툴바가 보내준다) ---------------- */
const S = {
  tool: 'pen',
  eraserMode: 'stroke',
  color: '#ff3b30',
  penSize: 6,
  hiSize: 24,
  eraserSize: 40,
  screenLock: true,
  touchWrite: true,
  palmErase: true,
  palmThreshold: 45,
  modalOpen: false
};

let strokes = [];
let history = [];
let redoStack = [];
let strokeSeq = 0;
const active = new Map();

/* ---------------- 캔버스 크기 ---------------- */
let dpr = 1;
function resizeCanvas() {
  dpr = window.devicePixelRatio || 1;
  for (const cv of [base, live]) {
    cv.width = Math.round(window.innerWidth * dpr);
    cv.height = Math.round(window.innerHeight * dpr);
    cv.style.width = window.innerWidth + 'px';
    cv.style.height = window.innerHeight + 'px';
  }
  for (const c of [bctx, lctx]) {
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.lineCap = 'round';
    c.lineJoin = 'round';
  }
  rebuildBase();
  redrawLive();
}
window.addEventListener('resize', resizeCanvas);

/* ---------------- 획 그리기 ---------------- */
function widthAt(st, p) {
  if (st.tool === 'pen') return Math.max(0.6, st.size * (0.45 + 1.1 * (p.p === undefined ? 0.5 : p.p)));
  return st.size;
}

function beginStyle(c, st) {
  c.globalCompositeOperation = st.comp;
  c.globalAlpha = st.alpha;
  c.strokeStyle = st.color;
  c.fillStyle = st.color;
  c.lineCap = 'round';
  c.lineJoin = 'round';
}

// 점 하나짜리 획 (톡 찍은 경우)
function drawDot(c, st) {
  const p = st.pts[0];
  c.beginPath();
  c.fillStyle = (st.auto && p.c) ? p.c : st.color;
  c.arc(p.x, p.y, widthAt(st, p) / 2, 0, Math.PI * 2);
  c.fill();
}

/* 세그먼트 단위로 이어 그리기 — from 번째 점부터.
 * 불투명한 펜/지우개는 겹쳐 그려도 티가 안 나므로 새로 들어온 구간만 이어 붙일 수 있다. */
function drawSegments(c, st, from) {
  const pts = st.pts;
  c.save();
  beginStyle(c, st);
  if (pts.length === 1) { if (from <= 1) drawDot(c, st); c.restore(); return; }
  for (let i = Math.max(1, from); i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], prev = pts[i - 2] || a;
    if (st.auto && b.c) c.strokeStyle = b.c;      // 배경이 바뀌면 획 색도 따라 바뀐다
    c.beginPath();
    c.lineWidth = (st.tool === 'pen') ? (widthAt(st, a) + widthAt(st, b)) / 2 : st.size;
    c.moveTo((prev.x + a.x) / 2, (prev.y + a.y) / 2);
    c.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
    if (i === pts.length - 1) c.lineTo(b.x, b.y);
    c.stroke();
  }
  c.restore();
}

/* 형광펜은 반투명이라 세그먼트를 겹쳐 그리면 이음새가 진해진다. 항상 path 하나로 그린다. */
function drawWholePath(c, st) {
  const pts = st.pts;
  if (!pts.length) return;
  c.save();
  beginStyle(c, st);
  if (pts.length === 1) { drawDot(c, st); c.restore(); return; }
  c.lineWidth = st.size;
  c.beginPath();
  c.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    c.quadraticCurveTo(pts[i].x, pts[i].y,
      (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2);
  }
  c.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
  c.stroke();
  c.restore();
}

function renderStroke(c, st) {
  if (st.tool === 'highlighter') drawWholePath(c, st);
  else drawSegments(c, st, 1);
}

function clearAllOf(c, cv) {
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, cv.width, cv.height);
  c.restore();
}

function rebuildBase() {
  clearAllOf(bctx, base);
  for (const st of strokes) if (!st.gone) renderStroke(bctx, st);
}

/* ---------------- live 레이어 ----------------
 * 매 프레임 화면 전체를 지우지 않고, 실제로 그린 영역(dirty)만 지운다. */
let dirty = null;
function markDirty(x, y, r) {
  const a = { x0: x - r, y0: y - r, x1: x + r, y1: y + r };
  if (!dirty) dirty = a;
  else {
    dirty.x0 = Math.min(dirty.x0, a.x0); dirty.y0 = Math.min(dirty.y0, a.y0);
    dirty.x1 = Math.max(dirty.x1, a.x1); dirty.y1 = Math.max(dirty.y1, a.y1);
  }
}
function markStrokeDirty(st) {
  const r = st.size + 4;
  for (const p of st.pts) markDirty(p.x, p.y, r);
}
function clearLive() {
  if (!dirty) return;
  lctx.clearRect(dirty.x0, dirty.y0, dirty.x1 - dirty.x0, dirty.y1 - dirty.y0);
  dirty = null;
}

// 진행 중인 획 전부를 처음부터 다시 (레이어를 통째로 비워야 할 때만)
function redrawLive() {
  clearAllOf(lctx, live);
  dirty = null;
  // 영역 지우개는 base 에 직접 반영되므로 다시 그릴 필요가 없다
  for (const a of active.values()) if (a.stroke && a.stroke.comp !== 'destination-out') a.drawn = 0;
  if (active.size) requestPaint();
}

let paintQueued = false;
let paintFallback = null;

function paintNow() {
  paintQueued = false;
  if (paintFallback) { clearTimeout(paintFallback); paintFallback = null; }

  // 형광펜이 진행 중이면 그 획은 통째로 다시 그려야 하므로 live 를 한 번 비운다
  let needFull = false;
  for (const a of active.values())
    if (a.stroke && a.stroke.tool === 'highlighter') needFull = true;
  if (needFull) {
    clearLive();
    for (const a of active.values()) if (a.stroke && a.stroke.comp !== 'destination-out') a.drawn = 0;
  }

  for (const a of active.values()) {
    const st = a.stroke;
    if (!st || st.comp === 'destination-out') continue;   // 영역 지우개는 base 에 직접 반영
    if (st.tool === 'highlighter') {
      drawWholePath(lctx, st);
      markStrokeDirty(st);
      a.drawn = st.pts.length;
    } else if (a.drawn < st.pts.length) {
      drawSegments(lctx, st, Math.max(1, a.drawn));
      for (let i = Math.max(0, a.drawn - 1); i < st.pts.length; i++)
        markDirty(st.pts[i].x, st.pts[i].y, widthAt(st, st.pts[i]) + 4);
      a.drawn = st.pts.length;
    }
  }
}

function requestPaint() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => { if (paintQueued) paintNow(); });
  // rAF 가 멈추는 환경(창이 완전히 가려지는 등)을 대비한 보험
  paintFallback = setTimeout(() => { if (paintQueued) paintNow(); }, 250);
}

/* ---------------- 자동 대비 색 ----------------
 * 아래 화면을 작게 찍어 두고, 획이 지나는 지점의 색을 읽어 반전색을 고른다. */
const bgCanvas = document.createElement('canvas');
const bgCtx = bgCanvas.getContext('2d', { willReadFrequently: true });
let bgData = null;
let bgBusy = false;

async function refreshBackdrop() {
  if (bgBusy) return;
  bgBusy = true;
  try {
    const shot = await window.pipen.captureScreen();
    if (!shot) return;
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = shot.dataURL; });
    bgCanvas.width = shot.width;
    bgCanvas.height = shot.height;
    bgCtx.drawImage(img, 0, 0, shot.width, shot.height);
    bgData = bgCtx.getImageData(0, 0, shot.width, shot.height);
  } catch (_) {
    // 캡처 실패 — 직전 스냅샷을 그대로 쓴다
  } finally {
    bgBusy = false;
  }
}

const lum = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

function contrastColorAt(x, y) {
  if (!bgData) return '#ff3b30';
  const sx = Math.min(bgData.width - 1, Math.max(0, Math.round(x / window.innerWidth * bgData.width)));
  const sy = Math.min(bgData.height - 1, Math.max(0, Math.round(y / window.innerHeight * bgData.height)));

  let r = 0, g = 0, b = 0, n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const px = Math.min(bgData.width - 1, Math.max(0, sx + dx));
      const py = Math.min(bgData.height - 1, Math.max(0, sy + dy));
      const i = (py * bgData.width + px) * 4;
      r += bgData.data[i]; g += bgData.data[i + 1]; b += bgData.data[i + 2]; n++;
    }
  }
  r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);

  const L = lum(r, g, b);
  const ir = 255 - r, ig = 255 - g, ib = 255 - b;
  if (Math.abs(lum(ir, ig, ib) - L) < 0.35) return L > 0.5 ? '#111111' : '#f2f2f2';
  return '#' + [ir, ig, ib].map(v => v.toString(16).padStart(2, '0')).join('');
}

/* 자동 대비를 쓰는 동안에만, 그리고 있지 않을 때만 다시 찍는다.
 * 화면 캡처는 무거워서 필기 중에 돌면 아래 화면 애니메이션까지 끊긴다. */
setInterval(() => {
  if (S.color === 'auto' && S.tool !== 'mouse' && active.size === 0) refreshBackdrop();
}, 2500);

/* ---------------- 입력 ---------------- */
function captureInput() { return S.tool !== 'mouse' && S.screenLock; }

function applyMode() {
  const on = captureInput() || S.modalOpen;
  live.style.pointerEvents = captureInput() ? 'auto' : 'none';
  window.pipen.setOverlayInteractive(on);
}

/* ---------------- 팜(손바닥) 지우개 ----------------
 * 접촉 크기(e.width/height)로 판단하는 게 원칙이지만, 적외선/광학 방식 전자칠판은
 * 접촉 크기를 아예 보고하지 않고 항상 1 로 주는 경우가 많다. 게다가 이런 칠판은
 * 아무 물체나 "펜"으로 인식하므로 스타일러스(pointerType 'pen')도 구분되지 않는다.
 * 즉 크기로도, 입력 종류로도 손바닥을 알아낼 방법이 없어 팜 지우개가 동작하지 않았다.
 *
 * 남는 단서는 "동시에 닿은 접점의 개수"다. 손바닥이나 여러 손가락으로 문지르면
 * 접점이 거의 같은 순간에 둘 이상 생긴다. 반면 글씨를 쓸 때는 접점이 하나다.
 * 그래서 접점 둘이 PALM_WINDOW 안에 함께 닿으면 그 동작 전체를 지우개로 바꾼다.
 * 이때 방금 그려진 짧은 잉크는 아직 확정 전(live 레이어)이라 그냥 버리면 된다.
 *
 * 이미 한참 글씨를 쓰던 중에 뒤늦게 닿은 접점은 바꾸지 않는다. 그래야 쓰던 글씨가
 * 통째로 지워지는 일이 없다. */
const PALM_WINDOW = 300;     // ms — 이 안에 함께 닿아야 한 동작으로 본다
let sizeReported = false;    // 접촉 크기를 실제로 보고하는 기기인가
let palmHintShown = false;

function reportTouch(c) {
  window.pipen.toToolbar({ touchSize: Math.round(c), sizeReported });
}

// 접촉 크기로 알아보는 팜 (크기를 보고하는 기기에서만 성립)
function isPalmBySize(e) {
  if (e.pointerType !== 'touch') return false;
  const c = Math.max(e.width || 0, e.height || 0);
  if (c > 1) sizeReported = true;
  if (c > 0) reportTouch(c);
  if (!S.palmErase || !sizeReported) return false;
  return c >= S.palmThreshold;
}

// 진행 중인 그리기 획을 지우개로 바꾼다 (지금까지 지나온 자취를 그대로 지운다)
function convertToEraser(a, e) {
  const pts = a.stroke ? a.stroke.pts : [];
  const er = makeStroke('eraseArea', e);
  er.size = Math.max(er.size, S.eraserSize * 1.5);
  er.pts = pts;
  a.stroke = er;
  a.kind = 'eraseArea';
  a.drawn = 0;
}

// 동시 접촉으로 알아보는 팜 (어떤 기기에서도 성립) — 새 접점을 등록하기 전에 부른다
function isPalmByMultiTouch(e) {
  if (!S.palmErase) return false;

  let companion = false;
  for (const a of active.values()) {
    if (a.kind === 'eraseArea') return true;              // 이미 지우는 중이면 같이 지운다
    if (a.kind === 'eraseStroke') continue;               // 획 지우개는 그대로 둔다
    if (a.stroke && Date.now() - a.startedAt <= PALM_WINDOW) companion = true;
  }
  if (!companion) return false;

  for (const a of active.values())
    if (a.stroke && a.stroke.comp !== 'destination-out') convertToEraser(a, e);
  redrawLive();                                           // 방금까지 그려둔 잉크를 버린다
  for (const a of active.values()) {
    if (!a.stroke || a.stroke.comp !== 'destination-out') continue;
    drawSegments(bctx, a.stroke, 1);
    a.drawn = a.stroke.pts.length;
  }
  if (!palmHintShown) { palmHintShown = true; toast('손바닥·두 손가락으로 문지르면 지워집니다'); }
  return true;
}

function makeStroke(kind, e) {
  const id = ++strokeSeq;
  if (kind === 'eraseArea') {
    const c = Math.max(e.width || 0, e.height || 0);
    const size = (e.pointerType === 'touch' && c > 1)
      ? Math.max(S.eraserSize, c * 1.6) : S.eraserSize;
    return { id, tool: 'eraser', color: '#000', size, alpha: 1, comp: 'destination-out', pts: [], gone: false };
  }
  const auto = S.color === 'auto';
  const color = auto ? contrastColorAt(e.clientX, e.clientY) : S.color;
  if (kind === 'highlighter')
    return { id, tool: 'highlighter', color, auto, size: S.hiSize, alpha: 0.32, comp: 'source-over', pts: [], gone: false };
  return { id, tool: 'pen', color, auto, size: S.penSize, alpha: 1, comp: 'source-over', pts: [], gone: false };
}

function pointOf(e, auto) {
  const p = { x: e.clientX, y: e.clientY, p: e.pressure > 0 ? e.pressure : 0.5 };
  if (auto) p.c = contrastColorAt(p.x, p.y);   // 지나는 지점마다 배경 반전색
  return p;
}

live.addEventListener('pointerdown', (e) => {
  if (!captureInput()) return;
  const palm = isPalmBySize(e) || isPalmByMultiTouch(e);
  if (e.pointerType === 'touch' && !S.touchWrite && !palm) return;

  try { live.setPointerCapture(e.pointerId); } catch (_) { /* 캡처 실패는 무시 */ }
  e.preventDefault();

  let kind;
  if (palm) kind = 'eraseArea';
  else if (S.tool === 'eraser') kind = (S.eraserMode === 'stroke') ? 'eraseStroke' : 'eraseArea';
  else kind = S.tool;

  if (kind === 'eraseStroke') {
    const removed = [];
    active.set(e.pointerId, { kind, removed, stroke: null, t: Date.now(), startedAt: Date.now(), drawn: 0 });
    eraseStrokeAt(pointOf(e), removed);
    notifyDrawing();
    return;
  }

  const stroke = makeStroke(kind, e);
  stroke.pts.push(pointOf(e, stroke.auto));
  const a = { kind, stroke, t: Date.now(), startedAt: Date.now(), drawn: 0 };
  active.set(e.pointerId, a);
  if (stroke.comp === 'destination-out') { drawSegments(bctx, stroke, 1); a.drawn = 1; }
  else requestPaint();
  notifyDrawing();
}, { passive: false });

live.addEventListener('pointermove', (e) => {
  const a = active.get(e.pointerId);
  if (!a) return;
  e.preventDefault();
  a.t = Date.now();

  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];

  if (a.kind === 'eraseStroke') {
    for (const ev of events) eraseStrokeAt(pointOf(ev), a.removed);
    return;
  }

  const st = a.stroke;
  for (const ev of events) {
    const p = pointOf(ev, st.auto);
    const last = st.pts[st.pts.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) < 0.7) continue;
    st.pts.push(p);
  }

  if (st.comp === 'destination-out') {
    // 영역 지우개는 base 를 직접 깎는다 (live 에 그리면 아래 그림이 안 지워진다)
    if (a.drawn < st.pts.length) { drawSegments(bctx, st, Math.max(1, a.drawn)); a.drawn = st.pts.length; }
    return;
  }
  requestPaint();
}, { passive: false });

function endPointer(e) { finishStroke(e.pointerId); }
live.addEventListener('pointerup', endPointer);
live.addEventListener('pointercancel', endPointer);
live.addEventListener('lostpointercapture', endPointer);
window.addEventListener('blur', () => { for (const id of [...active.keys()]) finishStroke(id); });

function finishStroke(pointerId) {
  const a = active.get(pointerId);
  if (!a) return;
  active.delete(pointerId);

  if (a.kind === 'eraseStroke') {
    if (a.removed.length) { history.push({ kind: 'erase', ids: a.removed.slice() }); redoStack = []; }
    notifyDrawing();
    return;
  }
  const st = a.stroke;
  if (!st || st.pts.length === 0) { redrawLive(); notifyDrawing(); return; }
  strokes.push(st);
  history.push({ kind: 'draw', id: st.id });
  redoStack = [];
  if (st.comp === 'destination-out') {
    if (a.drawn < st.pts.length) drawSegments(bctx, st, Math.max(1, a.drawn));
  } else {
    renderStroke(bctx, st);      // 확정 그림으로 옮기고
    redrawLive();                // live 를 비운다
  }
  notifyDrawing();
}

/* 그리는 중에는 메인 프로세스가 툴바를 다시 띄우는(z-order 보정) 작업을 쉬게 한다.
 * 그 작업이 필기 중에 돌면 아래 화면의 합성이 흔들려 애니메이션이 끊긴다. */
let drawingFlag = false;
function notifyDrawing() {
  const on = active.size > 0;
  if (on === drawingFlag) return;
  drawingFlag = on;
  window.pipen.setDrawing(on);
  if (!on) window.pipen.raiseToolbar();   // 획이 끝나면 툴바를 다시 위로
}

/* pointerup 을 놓쳐 획이 남아 있으면(포커스 전환 등) 정리한다 */
setInterval(() => {
  const now = Date.now();
  for (const [id, a] of active) if (now - a.t > 4000) finishStroke(id);
}, 2000);

/* 획 단위 지우기 */
function eraseStrokeAt(p, removedOut) {
  let hit = false;
  for (let i = strokes.length - 1; i >= 0; i--) {
    const st = strokes[i];
    if (st.gone || st.comp === 'destination-out') continue;
    if (hitStroke(st, p, 12 + st.size / 2)) {
      st.gone = true;
      removedOut.push(st.id);
      hit = true;
    }
  }
  if (hit) rebuildBase();
}

function hitStroke(st, p, tol) {
  const pts = st.pts;
  if (pts.length === 1) return Math.hypot(pts[0].x - p.x, pts[0].y - p.y) <= tol;
  for (let i = 1; i < pts.length; i++) if (distToSeg(p, pts[i - 1], pts[i]) <= tol) return true;
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
  else for (const id of op.ids) { const s = findStroke(id); if (s) s.gone = false; }
  redoStack.push(op); rebuildBase();
}
function redo() {
  const op = redoStack.pop();
  if (!op) { toast('다시 실행할 작업이 없습니다'); return; }
  if (op.kind === 'draw') { const s = findStroke(op.id); if (s) s.gone = false; }
  else for (const id of op.ids) { const s = findStroke(id); if (s) s.gone = true; }
  history.push(op); rebuildBase();
}
function clearAll() {
  const ids = strokes.filter(s => !s.gone).map(s => s.id);
  if (!ids.length) { toast('지울 내용이 없습니다'); return; }
  for (const id of ids) findStroke(id).gone = true;
  history.push({ kind: 'clear', ids }); redoStack = [];
  rebuildBase(); redrawLive(); toast('전체 지움');
}

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
    el.addEventListener('click', (ev) => { ev.preventDefault(); window.pipen.openExternal(el.dataset.url); });
  });
  S.modalOpen = true;
  modal.classList.add('show');
  window.pipen.setOverlayFocusable(true);
  applyMode();
}

function closeModal() {
  S.modalOpen = false;
  modal.classList.remove('show');
  window.pipen.setOverlayFocusable(false);
  applyMode();
}
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.modalOpen) closeModal(); });

function showInfo() {
  const body =
    '<div class="row"><span>버전</span><b>v' + appInfo.version + '</b></div>' +
    '<div class="row"><span>제작</span><a data-url="' + appInfo.homepage + '" href="#">pi-dimension.com</a></div>' +
    '<div class="row"><span>릴리즈</span><a data-url="' + appInfo.releases + '" href="#">github.com/cherub8128/white-board</a></div>' +
    '<div class="row"><span>라이선스</span><b>MIT</b></div>';
  openModal('Pi Pen', body, [
    { label: '업데이트 확인', onclick: () => { toast('업데이트를 확인하는 중...'); window.pipen.checkUpdate(); } },
    { label: '닫기', primary: true }
  ]);
}

window.pipen.getInfo().then((i) => { appInfo = i; });

window.pipen.onUpdateAvailable((info) => {
  const notes = info.notes ? '<div class="notes">' + escapeHtml(info.notes.slice(0, 800)) + '</div>' : '';
  openModal('새 버전이 있습니다',
    '<div class="row"><span>현재 버전</span><b>v' + info.current + '</b></div>' +
    '<div class="row"><span>최신 버전</span><b style="color:#6fa8ff">v' + info.latest + '</b></div>' + notes,
    [{ label: '나중에' }, { label: '다운로드', primary: true, onclick: () => window.pipen.openExternal(appInfo.releases) }]);
});
window.pipen.onUpdateNone((info) => {
  toast(info.failed ? '업데이트 정보를 가져오지 못했습니다' : '최신 버전입니다 (v' + info.current + ')');
});

function escapeHtml(t) {
  return t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ---------------- 토스트 ---------------- */
const toastEl = document.getElementById('toast');
let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1800);
}

/* ---------------- 툴바에서 오는 메시지 ---------------- */
window.pipen.onFromToolbar((m) => {
  if (m.state) {
    const wasAuto = S.color === 'auto';
    Object.assign(S, m.state);
    applyMode();
    if (S.color === 'auto' && !wasAuto) refreshBackdrop();
  }
  switch (m.cmd) {
    case 'undo': undo(); break;
    case 'redo': redo(); break;
    case 'clear': clearAll(); break;
    case 'info': showInfo(); break;
    case 'toast': toast(m.text); break;
  }
});

window.pipen.onShortcut((name) => { if (name === 'resize') resizeCanvas(); });

resizeCanvas();
applyMode();
