/**
 * screen3.js — 화면 3: AR 안내 (frontend/ar/app.js 통합본)
 *
 * 소유 DOM: #screen3 내부 전부
 *
 * 원본(frontend/ar/app.js)과 달라진 점:
 *   - 페이지 로드 시 바로 카메라를 켜지 않고, 화면3에 들어올 때 켜고 나갈 때 끈다.
 *   - 층·이동 상태·현재 위치를 URL 파라미터 대신 state.js 에서 가져온다.
 *   - 이미지 경로를 index.html 기준(ar/assets/...)으로 바꿨다.
 *   - '← 평면도' 버튼으로 화면2 복귀.
 *
 * 원칙:
 *   - 방향·목적지를 새로 계산하지 않는다. 경로 좌표는 백엔드 route.path 노드 좌표를 그대로 쓴다.
 *     (평면도 이미지가 없는 층만 DEFAULT_ROUTES 시연 좌표로 대체)
 *   - 카메라·센서·장애물 모델이 실패해도 안내 화면은 유지한다.
 *   - #screen3 의 .active 토글은 이 파일만 한다.
 *
 * 카메라 권한은 메인 화면에서 받는다. 이 화면은 권한을 묻지 않는다.
 * 카메라는 HTTPS 또는 localhost 에서만 동작한다.
 * (안드로이드: USB 연결 → PC 크롬 chrome://inspect → Port forwarding 5000)
 */

import { advanceDistance, largeObstacle } from '../ar-core.js';
import { postReroute } from '../api.js';
import { bindZoomGestures } from '../zoom-gestures.js';
import {
  SCREEN,
  getState,
  subscribe,
  goScreen,
  hasRoute,
  isNoRoute,
  currentScenario,
  nextPendingEvent,
  triggerEvent,
  setRoute,
  setLoading,
  isLoading,
} from '../state.js';

const $ = (s) => document.querySelector(s);
const screenEl = document.getElementById('screen3');

/* ───────── 시연용 데이터 (원본 app.js 그대로) ───────── */

const FLOOR_META = {
  '1f': ['1층', 'ar/assets/floor-1.webp'],
  '2f': ['2층', 'ar/assets/floor-2.webp'],
  '3f': ['3층', 'ar/assets/floor-3.webp'],
};
const DEFAULT_ROUTES = {
  '1f': [
    [45, 58],
    [73, 59],
    [89, 49],
    [92, 41],
  ],
  '2f': [
    [43, 61],
    [43, 66],
    [52, 66],
  ],
  // 새 전시동 3층 평면도 기준 (302호 → 서측 복도 → 서북쪽 비상구), 이미지 % 좌표
  '3f': [
    [23.8, 55.7],
    [18.6, 55.7],
    [18.6, 33.2],
    [11.5, 33.0],
  ],
};

// 원본의 걸음 인식 프로파일. 키를 state.js 의 mobility 키와 맞춘다.
const PROFILES = {
  independent: {
    distance: 0.7,
    minDelta: 1.8,
    maxDelta: 7,
    cooldown: 380,
    label: '보행 이동',
  },
  walking_aid: {
    distance: 0.4,
    minDelta: 1.15,
    maxDelta: 6,
    cooldown: 600,
    label: '보행 보조 이동',
  },
  wheelchair: {
    distance: 0.3,
    minDelta: 0.65,
    maxDelta: 4.5,
    cooldown: 520,
    label: '휠체어 이동',
  },
  need_help: {
    distance: 0.25,
    minDelta: 0.9,
    maxDelta: 5,
    cooldown: 750,
    label: '도움 필요 이동',
  },
};

/* ───────── 화면 진입마다 새로 잡는 값 ───────── */

let floor = '2f';
let route = DEFAULT_ROUTES['2f'];
let profile = PROFILES.independent;
let stepDistance = 0.7;
let total = 1;
let remaining = 1;
let targetBearing = 0;
let locationLabel = '—';
let segBearings = []; // 구간별 목표 방위(도)
let segEnds = []; // 구간별 누적 끝 거리
let segIndex = 0; // 현재 구간
let destinationType = 'exit'; // 'exit' | 'refuge' (백엔드 경로 결과 그대로)
let destinationLabel = '비상구';
let noRoute = false; // 경로 없음 폴백 모드
let arrived = false;
let headingOffset = null;   // 출발 방향 보정값: 켠 순간 바라보는 방향 = 첫 구간 방향

/* ───────── 실행 상태 ───────── */

let cameraStream = null;
let torch = false;
let voice = true;
let signal = false;
let signalBeep = null;
let signalVoice = null;
let heading = null;
let lastMagnitude = 0;
let lastStep = 0;
let model = null;
let visionTimer = null;
let busy = false;
let blocked = false;
let rejected = [];
let sensorsBound = false;

/**
 * 백엔드 경로(route.path)에서 출발 층의 연속 구간 좌표를 꺼낸다.
 * building.json 의 해당 층 노드 x,y 가 평면도 이미지 기준 % 좌표일 때만 사용한다.
 * 경로를 새로 만들지 않고, 받은 노드 순서를 그대로 잇는다. (원칙 1)
 */
function routePointsOnFloor(r, floorNo) {
  const b = getState().building;
  if (!r || r.status !== 'ok' || floorNo == null || !b?.floor_images?.[String(floorNo)]) return null;
  const from = r.path.findIndex((n) => n.floor === floorNo);
  if (from < 0) return null;
  const pts = [];
  for (let i = from; i < r.path.length && r.path[i].floor === floorNo; i++) {
    pts.push([Number(r.path[i].x), Number(r.path[i].y)]);
  }
  return pts.length >= 2 ? pts : null;
}

/** 현재 route 좌표로 구간 방위·길이를 계산한다 */
function buildGeometry() {
  // 구간마다 방위를 미리 계산해 두고, 걸음이 쌓이면 다음 구간 방위로 넘어간다
  segBearings = [];
  segEnds = [];
  let acc = 0;
  // 이미지 % 좌표는 가로·세로 단위가 달라서 세로에 (세로/가로) 비율을 곱해야 실제 각도가 된다
  const img = getState().building?.floor_images?.[String(Number.parseInt(floor, 10))];
  const aspect = img ? img.height / img.width : 1;
  for (let k = 1; k < route.length; k++) {
    const dx = route[k][0] - route[k - 1][0];
    const dy = (route[k][1] - route[k - 1][1]) * aspect;
    segBearings.push(((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360);
    acc += Math.hypot(dx, dy);
    segEnds.push(acc);
  }
  segIndex = 0;
  targetBearing = segBearings[0] ?? 0;
  total = Math.max(1, Math.round(acc));
  remaining = total;
}

/** 화면에 들어올 때 state 기준으로 안내 값을 초기화 */
function loadFromState() {
  const s = getState();
  const start = hasRoute() ? s.route.start : null;

  floor = start ? `${start.floor}f` : '2f';
  if (!FLOOR_META[floor]) floor = '2f';
  route = routePointsOnFloor(s.route, start?.floor) || DEFAULT_ROUTES[floor];

  const key = s.mobility || (s.route && s.route.mobility) || 'independent';
  profile = PROFILES[key] || PROFILES.independent;
  // 계단 사용 가능 경로는 보폭 0.7m, 계단을 사용할 수 없는 경로는 0.3m
  stepDistance = key === 'wheelchair' || key === 'need_help' ? 0.3 : 0.7;

  buildGeometry();
  headingOffset = null; // 화면에 들어올 때마다 다시 보정
  arrived = false;

  // 목적지 분기(원칙 2): 백엔드가 준 destination_type 을 그대로 따른다
  noRoute = isNoRoute() || !hasRoute();
  destinationType = hasRoute() ? s.route.destination_type : 'refuge';
  destinationLabel = hasRoute()
    ? s.route.destination.name
    : '방화문 안쪽 안전한 곳';
  rejected = [];
  locationLabel = start ? start.name : `${FLOOR_META[floor][0]}`;
}

/* ───────── 렌더링 ───────── */

function pointAt(percent) {
  const lengths = route
    .slice(1)
    .map((p, i) => Math.hypot(p[0] - route[i][0], p[1] - route[i][1]));
  const goal = (lengths.reduce((a, b) => a + b, 0) * percent) / 100;
  let walked = 0;
  for (let i = 0; i < lengths.length; i++) {
    if (walked + lengths[i] >= goal) {
      const t = (goal - walked) / (lengths[i] || 1);
      return [
        route[i][0] + (route[i + 1][0] - route[i][0]) * t,
        route[i][1] + (route[i + 1][1] - route[i][1]) * t,
      ];
    }
    walked += lengths[i];
  }
  return route.at(-1);
}

function render() {
  const pct = Math.max(0, Math.min(100, (1 - remaining / total) * 100));
  const point = pointAt(pct);
  const points = route.map((p) => p.join(',')).join(' ');
  const meta = FLOOR_META[floor];
  const exitName = destinationLabel;

  $('#exitName').textContent = exitName;
  $('#location').textContent = locationLabel;
  $('#distance').textContent = Math.ceil(remaining);
  $('#steps').textContent = Math.ceil(remaining / stepDistance);
  const floorNo = Number.parseInt(floor, 10);
  $('#mapImage').src = getState().building?.floor_images?.[String(floorNo)]?.src || meta[1];
  $('#mapImage').alt = `${meta[0]} 대피 경로`;
  $('#mapTitle').textContent = `${meta[0]} ${locationLabel} → ${exitName}`;
  $('#routeLine').setAttribute('points', points);
  $('#routeShadow').setAttribute('points', points);
  $('#exitDot').setAttribute('cx', route.at(-1)[0]);
  $('#exitDot').setAttribute('cy', route.at(-1)[1]);
  applyMapZoom(point);
  $('#progress').textContent =
    pct >= 100
      ? destinationType === 'exit'
        ? '비상구 도착'
        : '대피공간 도착 · 구조 대기'
      : pct > 0
        ? '대피 이동 중'
        : '출발 지점';
  $('#remaining').textContent = `약 ${Math.ceil(remaining)}m 남음`;
  $('#history').textContent = rejected.length
    ? `제외된 경로 ${rejected.length}개`
    : '제외된 경로 없음';
  $('#resetButton').disabled = !rejected.length;
}

/* ───────── 경로 지도 확대 ───────── */

/**
 * 경로 지도 모달은 열리자마자 경로 구간이 꽉 차게 확대된 상태로 보여준다.
 * 이미지와 경로선(svg)을 한 틀(.map-zoom)에 넣고 CSS transform 으로 확대·이동한다.
 * 보행자 아이콘은 크기가 같이 커지지 않도록 틀 밖에 두고 위치만 계산한다.
 */
let mapZoomEl = null;
let mapZoom = { s: 1, tx: 0, ty: 0 };
let mapZoomedIn = true; // 모달을 열 때마다 확대 상태로 시작
let lastWalkerPoint = [0, 0];

function ensureMapZoomWrapper() {
  if (mapZoomEl) return mapZoomEl;
  const view = document.querySelector('#screen3 .map-view');
  const img = $('#mapImage');
  const svg = view?.querySelector('svg');
  if (!view || !img || !svg) return null;
  mapZoomEl = document.createElement('div');
  mapZoomEl.className = 'map-zoom';
  view.insertBefore(mapZoomEl, img);
  mapZoomEl.append(img, svg);
  // 두 번 탭: 확대 ↔ 전체 보기 / 두 손가락 터치: 전체 보기
  bindZoomGestures(view, {
    onDoubleTap: () => { mapZoomedIn = !mapZoomedIn; applyMapZoom(lastWalkerPoint); },
    onTwoFinger: () => { mapZoomedIn = false; applyMapZoom(lastWalkerPoint); },
  });
  return mapZoomEl;
}

function computeMapZoom() {
  const PAD = 8; // 경로 주변 여백(%)
  const MAX_SCALE = 3;
  const xs = route.map((p) => p[0]);
  const ys = route.map((p) => p[1]);
  const minX = Math.min(...xs) - PAD;
  const maxX = Math.max(...xs) + PAD;
  const minY = Math.min(...ys) - PAD;
  const maxY = Math.max(...ys) + PAD;
  // 가로·세로 % 는 같은 비율로 커지므로 더 넓은 쪽 기준으로 확대 배율을 정한다
  const sc = Math.max(1, Math.min(MAX_SCALE, 100 / (maxX - minX), 100 / (maxY - minY)));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  // 화면 중앙에 경로 중심이 오게, 평면도 밖 빈 공간이 보이지 않게 이동량을 제한한다
  const clamp = (v) => Math.max(100 - 100 * sc, Math.min(0, v));
  return { s: sc, tx: clamp(50 - cx * sc), ty: clamp(50 - cy * sc) };
}

function applyMapZoom(point) {
  const box = ensureMapZoomWrapper();
  const img = getState().building?.floor_images?.[String(Number.parseInt(floor, 10))];
  if (box) {
    if (img) box.style.aspectRatio = `${img.width} / ${img.height}`;
    mapZoom = mapZoomedIn ? computeMapZoom() : { s: 1, tx: 0, ty: 0 };
    box.style.transform = `translate(${mapZoom.tx}%, ${mapZoom.ty}%) scale(${mapZoom.s})`;
  }
  lastWalkerPoint = point;
  // 보행자 아이콘: 확대된 좌표로 환산해 위치만 옮긴다
  $('#walker').style.left = `${point[0] * mapZoom.s + mapZoom.tx}%`;
  $('#walker').style.top = `${point[1] * mapZoom.s + mapZoom.ty}%`;
}

function syncFireLocation() {
  const el = $('#fireLocation');
  const scenario = currentScenario();
  el.textContent = `화재 위치 · ${scenario ? scenario.name : '확인 중'}`;
  el.classList.toggle('marquee', el.scrollWidth > el.clientWidth);
}

function speak(text, force = false) {
  if (!voice || !window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ko-KR';
  u.rate = 0.92;
  if (force) speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

function setVoiceEnabled(enabled) {
  voice = !!enabled;
  $('#voiceButton').classList.toggle('active', voice);
  $('#voiceButton').setAttribute('aria-pressed', String(voice));
  if (!voice) window.speechSynthesis?.cancel();
}

/* ───────── 카메라 ───────── */

/**
 * 카메라 권한은 메인 화면에서 미리 받는다.
 * 이 화면에서는 권한을 묻지 않고, 이미 허용된 경우에만 후면 카메라를 바로 켠다.
 *   - 허용됨        → 즉시 후면 카메라 연결
 *   - 아직 안 물어봄 → 권한 창을 띄우지 않고 시뮬레이션 배경으로 안내 계속
 *   - 거부됨        → 동일하게 시뮬레이션 배경으로 안내 계속
 */
async function cameraPermission() {
  try {
    const status = await navigator.permissions.query({ name: 'camera' });
    return status.state; // 'granted' | 'prompt' | 'denied'
  } catch {
    return 'unknown'; // Permissions API 미지원 브라우저
  }
}

/** 후면 카메라 1회 요청. 후면을 강제하고, 없으면 기본 카메라(PC 테스트용). */
async function openRearCamera() {
  const size = { width: { ideal: 1280 }, height: { ideal: 720 } };
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { ...size, facingMode: { exact: 'environment' } },
      audio: false,
    });
  } catch (err) {
    if (err.name === 'NotAllowedError' || err.name === 'SecurityError')
      throw err;
    return navigator.mediaDevices.getUserMedia({
      video: { ...size, facingMode: { ideal: 'environment' } },
      audio: false,
    });
  }
}

async function startCamera() {
  if (cameraStream) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    $('#message').textContent =
      '보안 연결(HTTPS/localhost)이 아니라 시뮬레이션 화면으로 안내합니다.';
    return;
  }

  const permission = await cameraPermission();
  if (permission === 'denied' || permission === 'prompt') {
    // 권한은 화면1 '다음' 버튼에서 받는다. AR 화면에서는 권한 창을 띄우지 않는다.
    $('#message').textContent = '카메라 없이 안내합니다. 화살표 방향으로 이동하세요.';
    return;
  }

  try {
    const stream = await openRearCamera();
    // 카메라를 기다리는 사이 화면을 벗어났으면 바로 끈다
    if (!isActive()) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    cameraStream = stream;
    const video = $('#arCamera');
    video.srcObject = stream;
    video.muted = true;
    video.setAttribute('playsinline', '');
    await video.play().catch(() => {});

    const track = stream.getVideoTracks()[0];
    const hasTorch = !!track.getCapabilities?.().torch;
    $('#torchButton').disabled = !hasTorch;
    if (!noRoute)
      $('#message').textContent = hasTorch
        ? '후면 카메라 연결됨 · 손전등 사용 가능'
        : '후면 카메라 연결됨';
    startVision();
  } catch {
    $('#message').textContent =
      '카메라 없이 안내합니다. 화살표 방향으로 이동하세요.';
  }
}

/* ───────── 방향·걸음 센서 ───────── */

/** 안드로이드 크롬은 센서 권한 창이 없으므로 바로 구독한다. (권한 요청 없음) */
function startSensors() {
  if (sensorsBound) return;
  // 안드로이드: deviceorientationabsolute 가 실제 나침(북쪽 기준) 값을 준다.
  // 일반 deviceorientation 은 켤 때 방향이 0 이라 목표 방위와 비교할 수 없다.
  if ('ondeviceorientationabsolute' in window) {
    window.addEventListener('deviceorientationabsolute', onOrientation, true);
  } else {
    window.addEventListener('deviceorientation', onOrientation, true);
  }
  window.addEventListener('devicemotion', onMotion, true);
  sensorsBound = true;
}

function isActive() {
  return getState().screen === SCREEN.AR;
}

/** 화면 방향(세로/가로)에 따른 보정 각도 */
function screenAngle() {
  return (
    (screen.orientation && screen.orientation.angle) || window.orientation || 0
  );
}

let smoothTurn = null; // 흔들림을 줄인 화살표 회전값(도)

function onOrientation(e) {
  if (!isActive()) return;
  const raw =
    e.webkitCompassHeading ?? (e.alpha == null ? null : 360 - e.alpha);
  if (raw == null) return;
  const measured = (raw + screenAngle() + 360) % 360;
  // 출발 방향 보정: 첫 측정값을 '현재 구간 방향'으로 간주한다.
  // 시연 장소의 실제 동서남북과 평면도 이미지 방향이 달라도 안정적으로 안내된다.
  if (headingOffset == null) {
    headingOffset = (measured - (segBearings[segIndex] ?? 0) + 360) % 360;
    smoothTurn = null;
  }
  heading = (measured - headingOffset + 360) % 360;
  if (noRoute || arrived) return; // 도착·폴백 안내는 고정

  // 목표 방위와 현재 바라보는 방향의 차이 (-180 ~ 180, 오른쪽이 +)
  const rotation = ((targetBearing - heading + 540) % 360) - 180;

  // 급격한 튐 방지: 이전 값에 조금씩 따라가게 한다 (360↔0 경계 처리 포함)
  if (smoothTurn == null) smoothTurn = rotation;
  const diff = ((rotation - smoothTurn + 540) % 360) - 180;
  smoothTurn = ((smoothTurn + diff * 0.25 + 540) % 360) - 180;

  const mode =
    Math.abs(smoothTurn) < 30
      ? 'forward'
      : smoothTurn >= 30 && smoothTurn < 135
        ? 'right'
        : smoothTurn <= -30 && smoothTurn > -135
          ? 'left'
          : 'back';

  // 화살표: 뒤돌기가 아니면 목표 방향으로 실제 각도만큼 회전
  const arrow = $('#arrow');
  arrow.className = mode === 'back' ? 'arrow back' : 'arrow forward';
  screenEl.style.setProperty(
    '--ar-turn',
    mode === 'back' ? '0deg' : `${smoothTurn.toFixed(1)}deg`,
  );

  const labels = { right: '오른쪽', left: '왼쪽' };
  const icons = { forward: '⬆', right: '↱', left: '↰', back: '↶' };
  const icon = document.querySelector('#screen3 .direction-icon');
  if (icon) icon.textContent = icons[mode];
  $('#direction').textContent =
    mode === 'forward'
      ? '앞으로 직진하세요'
      : mode === 'back'
        ? '반대편으로 돌아서세요'
        : `${labels[mode]}으로 방향을 맞추세요`;
}

function onMotion(e) {
  if (!isActive()) return;
  const a = e.accelerationIncludingGravity;
  if (!a || remaining <= 0 || noRoute || arrived) return;
  const magnitude = Math.hypot(a.x || 0, a.y || 0, a.z || 0);
  const delta = Math.abs(magnitude - lastMagnitude);
  const now = Date.now();
  lastMagnitude = magnitude;
  if (
    delta <= profile.minDelta ||
    delta >= profile.maxDelta ||
    now - lastStep <= profile.cooldown
  )
    return;
  lastStep = now;

  const result = advanceDistance(remaining, {
    currentHeading: heading,
    target: targetBearing,
    step: profile.distance,
  });
  if (result.reason !== 'advanced') {
    $('#message').textContent =
      result.reason === 'wrong-direction'
        ? '화살표 방향으로 돌아서세요.'
        : '방향 센서를 확인하고 있습니다.';
    return;
  }
  remaining = result.distance;
  $('#message').textContent = blocked
    ? '장애물이 감지되었습니다. 통과 여부를 확인하세요.'
    : `${profile.label} · 올바른 방향으로 이동 중`;

  // 현재 구간 갱신: 모퉁이를 지나면 다음 구간 방위로 화살표 목표를 바꾼다
  const walked = total - remaining;
  let next = segEnds.findIndex((end) => walked < end);
  if (next === -1) next = segEnds.length - 1;
  if (next !== segIndex) {
    segIndex = next;
    targetBearing = segBearings[segIndex];
    speak('방향을 바꾸세요. 화살표를 따라가세요.', true);
  }
  updateNextTurnHint();
  render();

  if (!remaining) showArrival();
}

/** 다음 방향 전환까지 남은 걸음 안내 */
function updateNextTurnHint() {
  const hint = document.querySelector('#screen3 .direction-card p');
  if (!hint || noRoute || arrived) return;
  const walked = total - remaining;
  const isLast = segIndex >= segEnds.length - 1;
  const left = Math.max(0, segEnds[segIndex] - walked);
  const steps = Math.ceil(left / stepDistance);
  hint.textContent = isLast
    ? `약 ${steps}걸음 후 ${destinationType === 'exit' ? '비상구' : '대피공간'}에 도착합니다.`
    : `약 ${steps}걸음 후 방향을 바꿉니다.`;
}

/** 도착 안내: 비상구(외부 대피)와 대피공간(구조 대기)을 구분한다 */
function showArrival() {
  arrived = true;
  const hint = document.querySelector('#screen3 .direction-card p');
  const icon = document.querySelector('#screen3 .direction-icon');
  screenEl.style.setProperty('--ar-turn', '0deg');
  $('#arrow').className = 'arrow forward';
  $('#arScreen').classList.add('ar-arrived');
  if (destinationType === 'exit') {
    const r = getState().route;
    const otherFloor = r?.destination && r.start && r.destination.floor !== r.start.floor;
    if (icon) icon.textContent = '✓';
    if (otherFloor) {
      // 이 층 안내는 계단 입구까지. 계단으로 내려가 비상구로 나간다 (엘리베이터 안내 금지)
      $('#direction').textContent = '비상계단에 도착했습니다';
      if (hint) hint.textContent = `계단으로 ${r.destination.floor}층까지 내려간 뒤 ${r.destination.name}로 나가세요.`;
      speak(`비상계단에 도착했습니다. 계단으로 ${r.destination.floor}층까지 내려간 뒤 ${r.destination.name}로 나가세요.`, true);
    } else {
      $('#direction').textContent = '비상구에 도착했습니다';
      if (hint) hint.textContent = '건물 밖으로 나가 집결지로 이동하세요.';
      speak('비상구에 도착했습니다. 건물 밖으로 나가 집결지로 이동하세요.', true);
    }
  } else {
    if (icon) icon.textContent = '🛡';
    $('#direction').textContent = '대피공간에 도착했습니다';
    if (hint)
      hint.textContent =
        '방화문을 닫고 119에 위치를 알린 뒤 구조를 기다리세요.';
    speak(
      '대피공간에 도착했습니다. 방화문을 닫고 119에 위치를 알린 뒤 구조를 기다리세요.',
      true,
    );
  }
}

/** 경로 없음 폴백(원칙 3): 이동 안내 대신 구조 대기 안내 */
function showNoRoute() {
  const hint = document.querySelector('#screen3 .direction-card p');
  const icon = document.querySelector('#screen3 .direction-icon');
  $('#arScreen').classList.add('ar-no-route');
  if (icon) icon.textContent = '!';
  $('#direction').textContent = '방화문 안쪽으로 대피하세요';
  if (hint)
    hint.textContent = '문을 닫고 119에 현재 위치를 알린 뒤 구조를 기다리세요.';
  $('#message').textContent = '안전한 이동 경로를 찾지 못했습니다.';
  speak(
    '안전한 이동 경로를 찾지 못했습니다. 방화문 안쪽으로 대피하고 119에 위치를 알리세요.',
    true,
  );
}

/* ───────── 장애물 인식 (coco-ssd, 실패해도 안내 유지) ───────── */

async function startVision() {
  if (visionTimer) return;
  if (!window.cocoSsd) {
    $('#obstacleStatus').textContent = '장애물 모델을 불러오지 못했습니다.';
    return;
  }
  try {
    model = model || (await window.cocoSsd.load({ base: 'lite_mobilenet_v2' }));
    if (!isActive()) return;
    $('#obstacleStatus').textContent = '대형 장애물 자동 인식 중';
    visionTimer = setInterval(detect, 1100);
  } catch {
    $('#obstacleStatus').textContent = '장애물 인식을 시작할 수 없습니다.';
  }
}

async function detect() {
  const video = $('#arCamera');
  if (busy || !model || video.readyState < 2) return;
  busy = true;
  try {
    const items = await model.detect(video, 8, 0.55);
    const hits = items.filter((x) =>
      largeObstacle(x, video.videoWidth, video.videoHeight),
    );
    blocked = hits.length > 0;
    $('#arScreen').classList.toggle('blocked', blocked);
    $('#obstacleStatus').classList.toggle('detected', blocked);
    $('#obstacleStatus').textContent = blocked
      ? `대형 장애물 감지 · ${Math.round(Math.max(...hits.map((x) => x.score)) * 100)}%`
      : '대형 장애물 자동 인식 중';
    drawBoxes(hits);
  } finally {
    busy = false;
  }
}

function drawBoxes(items) {
  const c = $('#obstacleCanvas');
  const v = $('#arCamera');
  const ctx = c.getContext('2d');
  c.width = v.videoWidth || 640;
  c.height = v.videoHeight || 480;
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.strokeStyle = '#ff4d57';
  ctx.lineWidth = 5;
  items.forEach((x) => ctx.strokeRect(...x.bbox));
}

/* ───────── 호출 신호 ───────── */

function rescueBeep() {
  navigator.vibrate?.([250, 120, 250]);
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  const ac = new AC();
  const o = ac.createOscillator();
  const g = ac.createGain();
  const t = ac.currentTime;
  o.frequency.value = 950;
  g.gain.setValueAtTime(0.25, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
  o.connect(g).connect(ac.destination);
  o.start();
  o.stop(t + 0.45);
}

function setSignal(on) {
  signal = on;
  $('#signalButton').classList.toggle('active', signal);
  $('#signalButton').setAttribute('aria-pressed', String(signal));
  $('#arScreen').classList.toggle('signal-active', signal);
  clearInterval(signalBeep);
  clearInterval(signalVoice);
  if (signal) {
    rescueBeep();
    speak('도움이 필요합니다. 사람이 있습니다.', true);
    signalBeep = setInterval(rescueBeep, 1400);
    signalVoice = setInterval(
      () => speak('도움이 필요합니다. 사람이 있습니다.', true),
      6000,
    );
  } else {
    navigator.vibrate?.(0);
  }
}

/* ───────── 화면 진입 / 이탈 ───────── */

function enter() {
  // 화면 3에 들어올 때마다 음성 안내를 기본 활성 상태로 되돌린다.
  setVoiceEnabled(true);
  loadFromState();
  $('#arrow').className = 'arrow forward';
  $('#direction').textContent = '앞으로 직진하세요';
  $('#message').textContent = '카메라를 연결하고 있습니다.';
  $('#arScreen').classList.remove('ar-arrived', 'ar-no-route');
  smoothTurn = null;
  screenEl.style.setProperty('--ar-turn', '0deg');
  render();
  syncFireLocation();
  startCamera();
  if (noRoute) {
    showNoRoute();
    return; // 폴백 모드에서는 걸음·방향 안내를 하지 않는다
  }
  updateNextTurnHint();
  startSensors();
  const direction = $('#direction').textContent.trim();
  const hint = document.querySelector('#screen3 .direction-card p')?.textContent.trim();
  speak([direction, hint].filter(Boolean).join('. '), true);
}

function leave() {
  cameraStream?.getTracks().forEach((t) => t.stop());
  cameraStream = null;
  $('#arCamera').srcObject = null;
  clearInterval(visionTimer);
  visionTimer = null;
  if (signal) setSignal(false);
  window.speechSynthesis?.cancel();
  $('#mapModal').hidden = true;
  $('#mapButton').classList.remove('active');
}

let wasActive = false;
function syncScreen(s) {
  const active = s.screen === SCREEN.AR;
  screenEl.classList.toggle('active', active);
  if (active && !wasActive) enter();
  if (!active && wasActive) leave();
  wasActive = active;
}

/* ───────── 이벤트 ───────── */

$('#arBackButton').addEventListener('click', () => goScreen(SCREEN.PLAN));

$('#mapButton').addEventListener('click', () => {
  $('#mapModal').hidden = false;
  $('#mapButton').classList.add('active');
  mapZoomedIn = true; // 열 때는 항상 경로 확대 상태
  render();
});
$('#mapClose').addEventListener('click', () => {
  $('#mapModal').hidden = true;
  $('#mapButton').classList.remove('active');
});
$('#mapModal').addEventListener('click', (e) => {
  if (e.target === $('#mapModal')) $('#mapClose').click();
});

$('#torchButton').addEventListener('click', async () => {
  const track = cameraStream?.getVideoTracks()[0];
  if (!track) return;
  try {
    torch = !torch;
    await track.applyConstraints({ advanced: [{ torch }] });
    $('#torchButton').classList.toggle('active', torch);
  } catch {
    $('#message').textContent = '이 카메라에서는 손전등을 제어할 수 없습니다.';
  }
});

$('#voiceButton').addEventListener('click', () => {
  setVoiceEnabled(!voice);
  if (voice) speak($('#direction').textContent, true);
});

$('#signalButton').addEventListener('click', () => setSignal(!signal));

/** 진행률을 백엔드 경로의 노드로 환산한다 (재탐색 출발 노드). 새 경로를 만들지 않는다. */
function currentRouteNodeId() {
  const r = getState().route;
  if (!r || r.status !== 'ok' || !r.legs?.length) return getState().startNodeId;
  const pct = Math.max(0, Math.min(1, 1 - remaining / total));
  // AR 은 출발 층 구간만 안내하므로 같은 층 구간만으로 진행률을 환산한다
  const floorOf = new Map(r.path.map((n) => [n.id, n.floor]));
  const startFloor = r.start?.floor;
  const legs = r.legs.filter((leg) => floorOf.get(leg.from) === startFloor && floorOf.get(leg.to) === startFloor);
  if (!legs.length) return r.start?.id ?? getState().startNodeId;
  const goal = legs.reduce((a, leg) => a + leg.dist, 0) * pct;
  let walked = 0;
  for (const leg of legs) {
    if (walked + leg.dist > goal) return leg.from; // 아직 도착하지 않은 구간의 출발 노드
    walked += leg.dist;
  }
  return legs.at(-1).to;
}

/** 다른 안전 출구 찾기: 경로 계산은 백엔드(다익스트라)가 한다 */
async function handleDetour() {
  if (isLoading('route')) return;
  const s = getState();
  const event = nextPendingEvent();
  if (!event) {
    $('#message').textContent = '추가로 확인된 위험이 없어 현재 경로를 유지합니다.';
    speak('추가로 확인된 위험이 없어 현재 경로를 유지합니다.', true);
    return;
  }

  const currentNode = currentRouteNodeId();
  const btn = $('#detourButton');
  btn.disabled = true;
  $('#message').textContent = '위험 구역을 반영해 경로를 다시 찾는 중…';
  triggerEvent(event.id);
  setLoading('route', true);

  try {
    const newRoute = await postReroute({
      mobility: s.mobility,
      currentNode,
      scenario: s.scenarioKey,
      events: getState().triggeredEvents,
    });
    setRoute(newRoute);
    rejected.push(destinationLabel);

    // 새 경로 결과로 목적지·폴백 여부만 갱신 (진행 상황과 화살표 좌표는 유지)
    noRoute = newRoute.status !== 'ok';
    destinationType = noRoute ? 'refuge' : newRoute.destination_type;
    destinationLabel = noRoute ? '방화문 안쪽 안전한 곳' : newRoute.destination.name;
    const reason = newRoute.hazard?.reasons?.[0] || event.label;

    if (!noRoute) {
      // 새 경로(현재 노드에서 출발)의 좌표로 화살표 구간을 다시 잡는다
      const pts = routePointsOnFloor(newRoute, newRoute.start?.floor);
      if (pts) {
        route = pts;
        buildGeometry(); // 보정값(headingOffset)은 유지
      }
    }
    render();
    if (noRoute) {
      showNoRoute();
    } else {
      $('#message').textContent = `${reason} · 새 경로로 안내합니다.`;
      speak(`${reason} 새 경로로 안내합니다.`, true);
      updateNextTurnHint();
    }
  } catch (err) {
    console.error('[screen3] 우회 경로 재탐색 실패', err);
    $('#message').textContent = '경로를 다시 찾지 못했습니다. 현재 안내를 유지합니다.';
  } finally {
    setLoading('route', false);
    btn.disabled = false;
  }
}

$('#detourButton').addEventListener('click', handleDetour);

// 방향 안내 카드를 두 번 누르면 지금 바라보는 방향으로 다시 보정
document.querySelector('#screen3 .direction-group')?.addEventListener('dblclick', () => {
  headingOffset = null;
  $('#message').textContent = '지금 바라보는 방향을 기준으로 다시 맞췄습니다.';
});
$('#resetButton').addEventListener('click', () => {
  rejected = [];
  $('#message').textContent = '제외한 경로 기록을 초기화했습니다.';
  render();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isActive()) $('#mapClose').click();
});
document.addEventListener('visibilitychange', () => {
  if (!isActive()) return;
  if (document.hidden) leave();
  else {
    startCamera();
  }
});
window.addEventListener('pagehide', leave);

subscribe(['screen'], syncScreen);
syncScreen(getState());
