/* ============================================================
 *  Pi Pen — 오버레이 창 (그리기 전담)
 *  도구 상태는 툴바 창에서 IPC 로 받아 적용한다.
 * ========================================================== */

const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d', { desynchronized: true });

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
  palmThreshold: 90,
  modalOpen: false
};

let strokes = [];
let history = [];
let redoStack = [];
let strokeSeq = 0;
const active = new Map();

/* ---------------- 캔버스 ----------------
 * 확정된 획은 오프스크린 레이어(base)에 한 번만 그리고,
 * 화면은 base + 진행 중인 획으로 합성한다. 반투명한 형광펜을 세그먼트마다
 * 겹쳐 그리면 이음새가 진해지므로, 획 하나는 항상 path 하나로 그린다. */
const base = document.createElement('canvas');
const bctx = base.getContext('2d');

let dpr = 1;
function resizeCanvas() {
  dpr = window.devicePixelRatio || 1;
  for (const cv of [canvas, base]) {
    cv.width = Math.round(window.innerWidth * dpr);
    cv.height = Math.round(window.innerHeight * dpr);
  }
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  for (const c of [ctx, bctx]) {
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.lineCap = 'round';
    c.lineJoin = 'round';
  }
  rebuildBase();
}
window.addEventListener('resize', resizeCanvas);

function widthAt(st, p) {
  if (st.tool === 'pen') return Math.max(0.6, st.size * (0.45 + 1.1 * (p.p === undefined ? 0.5 : p.p)));
  return st.size;
}

function renderStroke(c, st) {
  const pts = st.pts;
  if (pts.length === 0) return;

  c.save();
  c.globalCompositeOperation = st.comp;
  c.globalAlpha = st.alpha;
  c.strokeStyle = st.color;
  c.lineCap = 'round';
  c.lineJoin = 'round';

  if (pts.length === 1) {
    c.beginPath();
    c.fillStyle = (st.auto && pts[0].c) ? pts[0].c : st.color;
    c.arc(pts[0].x, pts[0].y, widthAt(st, pts[0]) / 2, 0, Math.PI * 2);
    c.fill();
    c.restore();
    return;
  }

  if (st.tool === 'pen') {
    // 필압에 따라 두께가 달라지므로 세그먼트 단위 (불투명이라 겹쳐도 티가 안 남)
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], prev = pts[i - 2] || a;
      if (st.auto && b.c) c.strokeStyle = b.c;   // 배경이 바뀌면 획 색도 따라 바뀐다
      c.beginPath();
      c.lineWidth = (widthAt(st, a) + widthAt(st, b)) / 2;
      c.moveTo((prev.x + a.x) / 2, (prev.y + a.y) / 2);
      c.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
      if (i === pts.length - 1) c.lineTo(b.x, b.y);
      c.stroke();
    }
  } else {
    c.lineWidth = st.size;
    c.beginPath();
    c.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      c.quadraticCurveTo(pts[i].x, pts[i].y,
        (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2);
    }
    c.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    c.stroke();   // 획 전체를 한 번의 stroke 로 — 이음새 겹침 없음
  }
  c.restore();
}

function clearCanvas(c, cv) {
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, cv.width, cv.height);
  c.restore();
}

function rebuildBase() {
  clearCanvas(bctx, base);
  for (const st of strokes) if (!st.gone) renderStroke(bctx, st);
  requestPaint();
}

/* 화면 합성 — 프레임당 한 번.
 * 창이 가려지는 등의 이유로 rAF 가 멈추면 그림이 안 나오므로 타이머로 한 번 더 보호한다. */
let paintQueued = false;
let paintFallback = null;
function paintNow() {
  paintQueued = false;
  if (paintFallback) { clearTimeout(paintFallback); paintFallback = null; }
  clearCanvas(ctx, canvas);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(base, 0, 0);
  ctx.restore();
  for (const a of active.values()) if (a.stroke) renderStroke(ctx, a.stroke);
}
function requestPaint() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => { if (paintQueued) paintNow(); });
  paintFallback = setTimeout(() => { if (paintQueued) paintNow(); }, 120);
}

/* ---------------- 자동 대비 색 ----------------
 * 아래 화면을 작게 찍어 두고, 획이 지나는 지점의 색을 읽어 반전색을 고른다.
 * 반전색이 배경과 밝기가 비슷해 잘 안 보이는 경우(회색 계열)에는 검정/흰색으로 밀어낸다. */
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

  // 주변 3x3 평균 — 글자 위 같은 잔무늬에서 색이 튀는 것을 막는다
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

/* 자동 대비를 쓰는 동안에는 화면이 바뀌어도 따라가도록 주기적으로 다시 찍는다 */
setInterval(() => {
  if (S.color === 'auto' && active.size === 0) refreshBackdrop();
}, 1500);

/* ---------------- 입력 ---------------- */
function captureInput() { return S.tool !== 'mouse' && S.screenLock; }

function applyMode() {
  const on = captureInput() || S.modalOpen;
  canvas.style.pointerEvents = captureInput() ? 'auto' : 'none';
  window.pipen.setOverlayInteractive(on);
}

function isPalm(e) {
  if (e.pointerType !== 'touch') return false;
  const c = Math.max(e.width || 0, e.height || 0);
  if (c > 0) window.pipen.toToolbar({ touchSize: Math.round(c) });
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

canvas.addEventListener('pointerdown', (e) => {
  if (!captureInput()) return;
  const palm = isPalm(e);
  if (e.pointerType === 'touch' && !S.touchWrite && !palm) return;

  try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* 캡처 실패는 무시 */ }
  e.preventDefault();

  let kind;
  if (palm) kind = 'eraseArea';
  else if (S.tool === 'eraser') kind = (S.eraserMode === 'stroke') ? 'eraseStroke' : 'eraseArea';
  else kind = S.tool;

  if (kind === 'eraseStroke') {
    const removed = [];
    active.set(e.pointerId, { kind, removed, stroke: null, t: Date.now() });
    eraseStrokeAt(pointOf(e), removed);
    return;
  }

  const stroke = makeStroke(kind, e);
  stroke.pts.push(pointOf(e, stroke.auto));
  active.set(e.pointerId, { kind, stroke, t: Date.now() });
  requestPaint();
}, { passive: false });

canvas.addEventListener('pointermove', (e) => {
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
  requestPaint();
}, { passive: false });

function endPointer(e) { finishStroke(e.pointerId); }
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('lostpointercapture', endPointer);
window.addEventListener('blur', () => { for (const id of [...active.keys()]) finishStroke(id); });

function finishStroke(pointerId) {
  const a = active.get(pointerId);
  if (!a) return;
  active.delete(pointerId);
  window.pipen.raiseToolbar();      // 그리는 동안 z-order 가 흔들려도 툴바가 계속 눌리도록

  if (a.kind === 'eraseStroke') {
    if (a.removed.length) { history.push({ kind: 'erase', ids: a.removed.slice() }); redoStack = []; }
    return;
  }
  const st = a.stroke;
  if (!st || st.pts.length === 0) { requestPaint(); return; }
  strokes.push(st);
  history.push({ kind: 'draw', id: st.id });
  redoStack = [];
  renderStroke(bctx, st);
  requestPaint();
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
  rebuildBase(); toast('전체 지움');
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
