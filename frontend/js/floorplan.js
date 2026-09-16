/**
 * floorplan.js — #floorplan SVG 전용 순수 렌더러.
 *
 * 원칙:
 *   - state.js / api.js 를 import 하지 않는다. 데이터는 전부 인자로 받는다.
 *   - 상태를 보관하지 않는다. 예외는 "직전 경로를 흐리게 남기기 위한" 캐시 하나(lastPathPoints).
 *   - 경로를 계산하거나 방향·목적지를 추정하지 않는다. 받은 배열을 그대로 잇는다.
 *   - index.html 에 이미 있는 레이어 <g> 4개에만 그린다.
 *       #layer-edges  복도 연결선
 *       #layer-path   대피 경로 (노드 아래에 깔림)
 *       #layer-nodes  노드 도형 + 이름 + 현재지점 표시
 *       #layer-hazard 차단 / 연기 표시
 *
 * 좌표: 노드 x,y 는 0~100.
 *   - 이미지 없음: viewBox "0 0 100 100", 좌표 그대로 사용.
 *   - 평면도 이미지 있음(building.floor_images): 노드 x,y 는 '이미지 기준 %' 이다.
 *     viewBox 를 "0 0 100 (100×세로/가로)" 로 바꾸고 y 에 같은 비율(yScale)을 곱해 이미지 위에 겹친다.
 *     이미지에 방·계단·비상구가 그려져 있으므로 복도선/복도점/계단/비상구 도형은 생략하고
 *     방은 투명한 탭 영역 + 선택 강조만, 대피공간(이미지에 없음)만 도형으로 그린다.
 *
 * 호출 순서 (층을 그린 뒤 위치를 참조하는 함수들이 따라온다):
 *   renderFloor → renderHazard → renderPath → markStart
 *   renderFloor 는 노드 레이어를 비우므로 현재지점 표시는 다시 markStart 해야 한다.
 *   renderHazard / markStart 는 renderFloor 가 그린 노드 위치를 사용한다.
 *   층을 바꿀 때는 clearPath() 로 이전 층 경로 캐시도 비울 것.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

// 범례(index.html 하단)와 맞춘 색
const COLORS = {
  path: '#34d399',        // emerald-400 대피 동선
  blocked: '#f43f5e',     // rose-500 차단 구역
  smoke: '#f59e0b',       // amber-500 연기
  start: '#22d3ee',       // cyan-400 현재지점
  startText: '#67e8f9',
  edge: '#1e4e5c',        // 어두운 청록 복도선
  roomFill: 'rgba(51, 78, 104, .35)',
  roomStroke: '#334e68',
  roomText: '#94a3b8',
  corridor: '#475569',
  stair: '#38bdf8',
  refuge: '#10b981',
  refugeStroke: '#a7f3d0',
  refugeText: '#6ee7b7',
  exit: '#22c55e',
  exitStroke: '#bbf7d0',
  exitText: '#86efac',
  labelHalo: '#061019',
};

const ROOM_W = 12;
const ROOM_H = 10;
const ROOM_STROKE_WIDTH = 0.8;

// 어두운 배경 위에서 라벨이 묻히지 않도록 테두리를 먼저 칠한다
const LABEL_HALO = {
  stroke: COLORS.labelHalo,
  'stroke-width': 0.7,
  'stroke-linejoin': 'round',
  'paint-order': 'stroke',
};

// 유일한 내부 캐시: 직전에 그린 경로의 points 문자열
let lastPathPoints = null;
// 현재 층 표시 방식 (renderFloor 가 정한다). 이미지 모드면 y 에 yScale 을 곱한다.
let yScale = 1;
let imageMode = false;
// 줌 상태: 현재 viewBox 와 층 식별값 (층이 바뀔 때만 전체 보기로 되돌린다)
let view = null;          // { x, y, w, h }
let viewKey = null;
let zoomAnim = 0;

const ROOM_W_IMG = 6;
const ROOM_H_IMG = 5.4;

/* ───────── 내부 도우미 ───────── */

function getLayer(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} 요소를 찾을 수 없습니다. index.html 의 평면도 구조를 확인하세요.`);
  return el;
}

function createSvg(tag, attrs = {}, parent) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) el.setAttribute(key, String(value));
  }
  if (parent) parent.appendChild(el);
  return el;
}

function createText(parent, content, attrs) {
  const text = createSvg('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', ...attrs }, parent);
  text.textContent = content;
  return text;
}

const hasPoint = node =>
  node != null && Number.isFinite(Number(node.x)) && Number.isFinite(Number(node.y));

/** 화면 좌표로 변환 (이미지 모드면 세로 비율 보정) */
const px = node => ({ x: Number(node.x), y: Number(node.y) * yScale });

/** 좌표가 있는 노드만 순서 그대로 이어 points 문자열로 만든다. 2점 미만이면 ''. */
function toPointsAttr(pathNodes) {
  const points = (pathNodes || []).filter(hasPoint).map(n => { const p = px(n); return `${p.x},${p.y}`; });
  return points.length >= 2 ? points.join(' ') : '';
}

/** renderFloor 가 그린 노드 그룹에서 위치를 읽는다 (상태를 따로 두지 않기 위함). */
function findNodeGroup(nodeId) {
  return [...getLayer('layer-nodes').querySelectorAll('g[data-node-id]')]
    .find(el => el.dataset.nodeId === nodeId) || null;
}

function readNodePositions() {
  const positions = new Map();
  getLayer('layer-nodes').querySelectorAll('g[data-node-id]').forEach(el => {
    positions.set(el.dataset.nodeId, { x: Number(el.dataset.x), y: Number(el.dataset.y) });
  });
  return positions;
}

/* ───────── 노드 도형 ───────── */

function drawRoom(group, node, x, y) {
  const label = node.name || node.id;
  const isLong = [...label].length > 5;

  if (imageMode) {
    // 이미지에 방 이름이 있으므로 투명 강조 틀 + 탭 영역만 그린다
    createSvg('rect', {
      class: 'room-shape',
      x: x - ROOM_W_IMG / 2, y: y - ROOM_H_IMG / 2, width: ROOM_W_IMG, height: ROOM_H_IMG, rx: 0.8,
      fill: 'transparent', stroke: 'transparent', 'stroke-width': ROOM_STROKE_WIDTH,
    }, group);
    createSvg('rect', {
      class: 'room-hit',
      'data-node-id': node.id,
      x: x - ROOM_W_IMG / 2, y: y - ROOM_H_IMG / 2, width: ROOM_W_IMG, height: ROOM_H_IMG,
      tabindex: 0,
      role: 'button',
      'aria-label': `${label} 선택`,
    }, group);
    return;
  }

  createSvg('rect', {
    class: 'room-shape',
    x: x - ROOM_W / 2, y: y - ROOM_H / 2, width: ROOM_W, height: ROOM_H, rx: 1.5,
    fill: COLORS.roomFill, stroke: COLORS.roomStroke, 'stroke-width': ROOM_STROKE_WIDTH,
  }, group);

  createText(group, label, {
    class: 'room-label',
    x, y,
    'font-size': isLong ? 2.2 : 2.8,
    'font-weight': 'bold',
    fill: COLORS.roomText,
    // 긴 이름은 사각형 폭에 맞춰 줄인다
    ...(isLong ? { textLength: ROOM_W - 1.5, lengthAdjust: 'spacingAndGlyphs' } : {}),
  });

  // 탭 영역: 시각 요소보다 크게, 맨 위에 덮는다
  createSvg('rect', {
    class: 'room-hit',
    'data-node-id': node.id,
    x: x - ROOM_W / 2 - 1, y: y - ROOM_H / 2 - 1, width: ROOM_W + 2, height: ROOM_H + 2,
    tabindex: 0,
    role: 'button',
    'aria-label': `${label} 선택`,
  }, group);
}

function drawCorridor(group, x, y) {
  createSvg('circle', { cx: x, cy: y, r: 1.2, fill: COLORS.corridor, opacity: 0.85 }, group);
}

function drawStair(group, node, x, y) {
  createSvg('rect', {
    x: x - 3, y: y - 2.4, width: 6, height: 4.8, rx: 0.8,
    fill: 'rgba(56, 189, 248, .12)', stroke: COLORS.stair, 'stroke-width': 0.6,
  }, group);
  // 계단 표시 (계단참 모양 꺾은선)
  createSvg('polyline', {
    points: [
      [x - 2, y + 1.6], [x - 2, y + 0.6], [x - 0.7, y + 0.6], [x - 0.7, y - 0.4],
      [x + 0.7, y - 0.4], [x + 0.7, y - 1.4], [x + 2, y - 1.4],
    ].map(p => p.join(',')).join(' '),
    fill: 'none', stroke: COLORS.stair, 'stroke-width': 0.45, 'stroke-linejoin': 'round',
  }, group);
  // 라벨은 짧게: "A계단(3층)" → "A계단"
  const shortLabel = String(node.name || '계단').split('(')[0].trim().slice(0, 4) || '계단';
  createText(group, shortLabel, {
    x, y: Math.min(98, y + 4.4),
    'font-size': 2.2, 'font-weight': 'bold', fill: COLORS.stair, ...LABEL_HALO,
  });
}

function drawRefuge(group, x, y) {
  createSvg('circle', {
    cx: x, cy: y, r: 3.2, fill: COLORS.refuge, stroke: COLORS.refugeStroke, 'stroke-width': 0.8,
  }, group);
  createText(group, '대피공간', {
    x, y: Math.max(2.5, y - 5.2),
    'font-size': 2.6, 'font-weight': 'bold', fill: COLORS.refugeText, ...LABEL_HALO,
  });
}

function drawExit(group, x, y) {
  createSvg('circle', {
    cx: x, cy: y, r: 4.6, fill: 'none', stroke: COLORS.exit, 'stroke-width': 0.5, opacity: 0.6,
  }, group);
  createSvg('circle', {
    cx: x, cy: y, r: 3.2, fill: COLORS.exit, stroke: COLORS.exitStroke, 'stroke-width': 0.8,
  }, group);
  createText(group, '비상구', {
    x, y: Math.max(2.5, y - 6.4),
    'font-size': 2.6, 'font-weight': 'bold', fill: COLORS.exitText, ...LABEL_HALO,
  });
}

function drawNode(parent, node) {
  const { x, y } = px(node);
  const group = createSvg('g', {
    'data-node-id': node.id,
    'data-type': node.type,
    'data-x': x,
    'data-y': y,
  }, parent);
  createSvg('title', {}, group).textContent = node.name || node.id;

  if (imageMode && node.type !== 'room' && node.type !== 'refuge') return; // 이미지에 이미 있음
  switch (node.type) {
    case 'room': drawRoom(group, node, x, y); break;
    case 'stair': drawStair(group, node, x, y); break;
    case 'refuge': drawRefuge(group, x, y); break;
    case 'exit': drawExit(group, x, y); break;
    default: drawCorridor(group, x, y);
  }
}

/* ───────── 공개 함수 ───────── */

/**
 * #floorplan 에 이벤트 위임을 1회 등록한다. room 노드를 탭하면 onSelectRoom(nodeId).
 * room 이외의 노드는 탭 대상이 아니다.
 */
export function initFloorplan({ onSelectRoom } = {}) {
  const svg = getLayer('floorplan');
  if (svg.dataset.floorplanBound === 'true') return;
  svg.dataset.floorplanBound = 'true';

  const selectFrom = target => {
    const hit = target?.closest?.('.room-hit');
    if (hit && typeof onSelectRoom === 'function') onSelectRoom(hit.dataset.nodeId);
  };

  svg.addEventListener('click', event => selectFrom(event.target));
  // 키보드 사용자도 방을 선택할 수 있게
  svg.addEventListener('keydown', event => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target?.closest?.('.room-hit')) {
      event.preventDefault();
      selectFrom(event.target);
    }
  });
}

/** 해당 층의 노드·엣지만 그린다. 호출할 때마다 엣지/노드 레이어를 비우고 다시 그린다. */
export function renderFloor({ nodes = [], edges = [], floor, image = null }) {
  const svg = getLayer('floorplan');
  const edgeLayer = getLayer('layer-edges');
  const nodeLayer = getLayer('layer-nodes');
  edgeLayer.replaceChildren();
  nodeLayer.replaceChildren();

  // 평면도 이미지 배경
  imageMode = !!(image && image.src && image.width && image.height);
  yScale = imageMode ? image.height / image.width : 1;
  const key = `${floor}|${imageMode ? image.src : ''}`;
  if (key !== viewKey || !view) {
    // 층이 바뀌면 전체 보기로
    viewKey = key;
    cancelAnimationFrame(zoomAnim);
    view = fullView();
    applyView(svg, view);
  }
  let bg = svg.querySelector('image.floor-image');
  if (imageMode) {
    if (!bg) {
      bg = createSvg('image', { class: 'floor-image', x: 0, y: 0, 'pointer-events': 'none' });
      svg.insertBefore(bg, edgeLayer); // 모든 레이어보다 아래
    }
    bg.setAttribute('href', image.src);
    bg.setAttribute('width', 100);
    bg.setAttribute('height', 100 * yScale);
  } else if (bg) {
    bg.remove();
  }

  const floorNodes = nodes.filter(n => Number(n.floor) === Number(floor) && hasPoint(n));
  const byId = new Map(floorNodes.map(n => [n.id, n]));

  for (const edge of imageMode ? [] : edges) { // 이미지 모드는 복도선을 그리지 않는다
    const a = byId.get(edge.from);
    const b = byId.get(edge.to);
    if (!a || !b) continue;
    createSvg('line', {
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      stroke: COLORS.edge, 'stroke-width': 1.1, 'stroke-linecap': 'round',
    }, edgeLayer);
  }

  // 방을 마지막에 그려 탭 영역이 다른 도형에 가리지 않게 한다
  const drawOrder = { corridor: 0, stair: 1, refuge: 2, exit: 3, room: 4 };
  [...floorNodes]
    .sort((a, b) => (drawOrder[a.type] ?? 0) - (drawOrder[b.type] ?? 0))
    .forEach(node => drawNode(nodeLayer, node));
}

/**
 * 경로 노드 배열을 순서 그대로 이어 그린다.
 * 직전 경로와 다르면 직전 경로를 .path-stale 로 흐리게 남긴다.
 * 그릴 점이 2개 미만이면(예: no_route) 새 경로 없이 직전 경로만 흐리게 남긴다.
 */
export function renderPath(pathNodes = []) {
  const pathLayer = getLayer('layer-path');
  pathLayer.replaceChildren();

  const nextPoints = toPointsAttr(pathNodes);

  if (lastPathPoints && lastPathPoints !== nextPoints) {
    createSvg('polyline', {
      class: 'path-stale',
      points: lastPathPoints,
      fill: 'none', stroke: COLORS.path, 'stroke-width': 1.2,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    }, pathLayer);
  }

  if (!nextPoints) return;

  const line = createSvg('polyline', {
    class: 'path-draw',
    points: nextPoints,
    fill: 'none', stroke: COLORS.path, 'stroke-width': 1.6,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    filter: 'url(#neonGlow)',
  }, pathLayer);

  // style.css 의 고정값(400) 대신 실제 길이로 덮어써야 그리기 애니메이션이 정확하다.
  // 시작 오프셋도 같은 길이로 맞춰야 첫 프레임에 선이 일부 보이지 않는다.
  try {
    const length = line.getTotalLength();
    if (length > 0) {
      line.style.strokeDasharray = String(length);
      line.style.strokeDashoffset = String(length);
    }
  } catch {
    // 길이를 잴 수 없는 환경에서는 CSS 기본값으로 둔다
  }

  lastPathPoints = nextPoints;
}

/* ───────── 줌 ───────── */

function fullView() {
  return { x: 0, y: 0, w: 100, h: 100 * yScale };
}

function applyView(svg, v) {
  svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
}

/** viewBox 를 부드럽게 옮긴다 (약 0.45초) */
function animateView(target) {
  const svg = getLayer('floorplan');
  const from = view || fullView();
  const start = performance.now();
  const DURATION = 450;
  cancelAnimationFrame(zoomAnim);
  const step = now => {
    const t = Math.min(1, (now - start) / DURATION);
    const e = 1 - Math.pow(1 - t, 3); // easeOutCubic
    view = {
      x: from.x + (target.x - from.x) * e,
      y: from.y + (target.y - from.y) * e,
      w: from.w + (target.w - from.w) * e,
      h: from.h + (target.h - from.h) * e,
    };
    applyView(svg, view);
    if (t < 1) zoomAnim = requestAnimationFrame(step);
  };
  zoomAnim = requestAnimationFrame(step);
}

/**
 * 주어진 노드들이 모두 보이도록 확대한다. (경로를 계산하지 않고 받은 좌표의 범위만 본다)
 * 화면 비율은 전체 평면도와 같게 유지하고, 평면도 밖으로 벗어나지 않게 맞춘다.
 * @param {object[]} nodes  x,y 가 있는 노드 배열 (예: 현재 층 경로 노드, 또는 [시작 노드])
 * @param {object} [opt]    { padding: 여백(%), minWidth: 최소 보기 폭(%) }
 */
export function zoomToNodes(nodes = [], { padding = 8, minWidth = 40 } = {}) {
  const pts = nodes.filter(hasPoint).map(px);
  if (!pts.length) return;
  const full = fullView();
  const aspect = full.h / full.w;

  let minX = Math.min(...pts.map(p => p.x)) - padding;
  let maxX = Math.max(...pts.map(p => p.x)) + padding;
  let minY = Math.min(...pts.map(p => p.y)) - padding;
  let maxY = Math.max(...pts.map(p => p.y)) + padding;

  let w = Math.max(maxX - minX, (maxY - minY) / aspect, minWidth);
  w = Math.min(w, full.w);
  const h = w * aspect;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const x = Math.max(0, Math.min(full.w - w, cx - w / 2));
  const y = Math.max(0, Math.min(full.h - h, cy - h / 2));
  animateView({ x, y, w, h });
}

/** 전체 평면도 보기로 되돌린다. */
export function resetZoom() {
  animateView(fullView());
}

/** 경로 레이어와 직전 경로 캐시를 비운다. */
export function clearPath() {
  getLayer('layer-path').replaceChildren();
  lastPathPoints = null;
}

/** 차단·연기 표시. 같은 노드가 둘 다면 차단이 우선한다. 현재 층에 그려진 노드만 표시된다. */
export function renderHazard({ blockedIds = [], smokeIds = [] } = {}) {
  const hazardLayer = getLayer('layer-hazard');
  hazardLayer.replaceChildren();

  const positions = readNodePositions();
  const blocked = new Set(blockedIds);

  for (const id of blocked) {
    const p = positions.get(id);
    if (!p) continue;
    const group = createSvg('g', { 'data-hazard': 'blocked', 'pointer-events': 'none' }, hazardLayer);
    createSvg('circle', {
      cx: p.x, cy: p.y, r: 6.5,
      fill: 'rgba(244, 63, 94, .14)', stroke: COLORS.blocked,
      'stroke-width': 0.7, 'stroke-dasharray': '1.5 1.5',
    }, group);
    createSvg('path', {
      d: `M${p.x - 2.4} ${p.y - 2.4} L${p.x + 2.4} ${p.y + 2.4} M${p.x + 2.4} ${p.y - 2.4} L${p.x - 2.4} ${p.y + 2.4}`,
      stroke: COLORS.blocked, 'stroke-width': 1.1, 'stroke-linecap': 'round',
    }, group);
  }

  for (const id of new Set(smokeIds)) {
    if (blocked.has(id)) continue;
    const p = positions.get(id);
    if (!p) continue;
    const group = createSvg('g', { 'data-hazard': 'smoke', 'pointer-events': 'none' }, hazardLayer);
    createSvg('circle', {
      cx: p.x, cy: p.y, r: 5.5,
      fill: 'rgba(245, 158, 11, .16)', stroke: COLORS.smoke,
      'stroke-width': 0.6, 'stroke-dasharray': '1 1.5',
    }, group);
  }
}

/** 현재지점 표시. nodeId 가 없거나 현재 층에 없으면 표시만 지운다. */
export function markStart(nodeId) {
  const nodeLayer = getLayer('layer-nodes');

  nodeLayer.querySelectorAll('.start-marker').forEach(el => el.remove());
  nodeLayer.querySelectorAll('g[data-start="true"]').forEach(group => {
    delete group.dataset.start;
    group.querySelector('.room-shape')?.setAttribute('stroke', COLORS.roomStroke);
    group.querySelector('.room-shape')?.setAttribute('stroke-width', String(ROOM_STROKE_WIDTH));
    group.querySelector('.room-label')?.setAttribute('fill', COLORS.roomText);
  });

  if (nodeId == null) return;
  const group = findNodeGroup(nodeId);
  if (!group) return;

  group.dataset.start = 'true';
  group.querySelector('.room-shape')?.setAttribute('stroke', COLORS.start);
  group.querySelector('.room-shape')?.setAttribute('stroke-width', '1.4');
  group.querySelector('.room-label')?.setAttribute('fill', COLORS.startText);

  const x = Number(group.dataset.x);
  const y = Number(group.dataset.y);
  const marker = createSvg('g', { class: 'start-marker', 'pointer-events': 'none' }, nodeLayer);
  createSvg('circle', {
    cx: x, cy: y, r: imageMode ? 5 : 9, fill: 'none', stroke: COLORS.start, 'stroke-width': 0.6, opacity: 0.6,
  }, marker);
  // 방이 아닌 지점(재탐색 시 복도 등)은 사각형 강조가 없으므로 점을 찍는다
  if (group.dataset.type !== 'room') {
    createSvg('circle', { cx: x, cy: y, r: 1.6, fill: COLORS.start }, marker);
  }
}
