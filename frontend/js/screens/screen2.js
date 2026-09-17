/**
 * screen2.js — 화면 2: 평면도 · 경로 · 행동요령 · 도움 요청
 *
 * 소유 DOM: #screen2 내부 전부, #help-modal, #toast
 *
 * 원칙:
 *   - 경로·방향·목적지를 계산하거나 추정하지 않는다. 백엔드 응답 값만 표시한다.
 *   - 상태는 state.js 의 action 으로만 바꾸고, 화면은 구독(subscribe)으로 다시 그린다.
 *   - #screen2 의 .active 토글은 이 파일만 한다. 다른 화면 섹션은 건드리지 않는다.
 *   - no_route 는 오류가 아니다. 구조 대기 안내를 보여주는 정상 흐름이다.
 *   - 순서: 경로를 먼저 그리고, 행동요령(/api/guide)은 나중에 채운다.
 *   - 도움 요청은 미리보기 후 기기의 문자 앱으로 전달할 수 있다.
 */

import { ICON_PATHS } from '../icons.js';
import {
  postRoute,
  postGuide,
  postReroute,
  postHelpMessage,
  getConfig,
} from '../api.js';
import {
  initFloorplan,
  renderFloor,
  renderPath,
  clearPath,
  renderHazard,
  markStart,
  zoomToNodes,
  resetZoom,
  isZoomed,
  cancelPendingSelect,
} from '../floorplan.js';
import { bindZoomGestures } from '../zoom-gestures.js';
import {
  SCREEN,
  getState,
  subscribe,
  goScreen,
  setRoute,
  setGuide,
  setHelpText,
  setLoading,
  setFloor,
  isLoading,
  setError,
  selectStartNode,
  triggerEvent,
  nextPendingEvent,
  currentScenario,
  nodesOnFloor,
  edgesOnFloor,
  nodeById,
  mobilityLabel,
  hasRoute,
  isNoRoute,
  destinationKindLabel,
  etaLabel,
  blockedNodeIds,
  smokeNodeIds,
  arCurrentNode,
} from '../state.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const TOAST_MS = 3000;

const $ = (id) => document.getElementById(id);

const screenEl = $('screen2');
const floorplanEl = $('floorplan');
const badgeBtn = $('mobility-badge');
const badgeIcon = $('badge-icon');
const badgeLabel = $('badge-label');
const summaryEl = $('route-summary');
const summaryEmpty = $('summary-empty');
const summaryBody = $('summary-body');
const destName = $('dest-name');
const destKind = $('dest-kind');
const statDist = $('stat-dist');
const statEta = $('stat-eta');
const statStart = $('stat-start');
const planLevel = $('plan-level');
const hazardChip = $('hazard-chip');
const eventBtn = $('btn-event');
const guideCard = $('guide-card');
const guideHeadline = $('guide-headline');
const guideSource = $('guide-source');
const guideSteps = $('guide-steps');
const guideCautions = $('guide-cautions');
const startArBtn = $('btn-start-ar');
const helpBtn = $('btn-help');
const helpModal = $('help-modal');
const helpTextEl = $('help-text');
const helpCloseBtn = $('btn-help-close');
const helpCopyBtn = $('btn-help-copy');
const helpKakaoBtn = $('btn-help-kakao');
const toastEl = $('toast');

async function initKakao() {
  try {
    const { kakao_javascript_key: key } = await getConfig();
    if (key && window.Kakao && !window.Kakao.isInitialized()) window.Kakao.init(key);
  } catch (err) {
    console.warn('[screen2] 카카오 공유 설정을 불러오지 못했습니다.', err);
  }
}

initKakao();

// 상단 로고·앱 이름을 누르면 첫 화면(이동 상태 선택)으로 이동
document.querySelectorAll('.brand-home').forEach((el) => {
  el.addEventListener('click', () => goScreen(SCREEN.MOBILITY));
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      goScreen(SCREEN.MOBILITY);
    }
  });
});

const WARNING_PATH =
  '<path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>';

/**
 * 이동 불가(need_help) 사용자 전용 행동요령.
 * 스스로 이동할 수 없으므로 경로·AR 대신 '제자리 안전 확보 + 구조 요청' 행동을 안내한다.
 * 경로·방향을 새로 만들지 않는 고정 문구다. (원칙 1, 4, 5)
 */
const IMMOBILE_KEY = 'need_help';
const IMMOBILE_GUIDE = {
  headline: '움직이지 말고 지금 있는 곳에서 안전을 확보하세요',
  steps: [
    '119에 전화해 건물 이름, 층, 방 번호와 "스스로 이동할 수 없다"는 사실을 알리세요.',
    '방문을 닫아 연기가 들어오지 않게 하세요. 가능하면 젖은 수건이나 옷으로 문틈을 막으세요.',
    '창문이 있으면 창가 쪽으로 몸을 두고, 연기가 들어오지 않을 때만 조금 열어 위치를 알리세요.',
    '연기가 차면 자세를 최대한 낮추고 젖은 천으로 코와 입을 막으세요.',
    '휴대폰 손전등, 소리, 옷을 흔들어 구조대에게 위치를 계속 알리세요.',
    '주변에 사람이 있으면 큰 소리로 도움을 요청하고, 아래 "도움 요청 내용 보기"로 위치 정보를 전달하세요.',
  ],
  cautions: [
    '무리해서 혼자 이동하지 마세요. 구조대가 올 때까지 위치를 알리는 것이 가장 중요합니다.',
    '화재 시 엘리베이터를 사용하지 마세요.',
  ],
};

function isImmobile(s = getState()) {
  return (s.mobility || s.route?.mobility) === IMMOBILE_KEY;
}

const DEST_KIND_BASE =
  'text-[10px] font-medium px-2 py-0.5 rounded border flex-shrink-0 ml-2 ';
const DEST_KIND_EXIT = 'text-emerald-400 bg-slate-900/80 border-emerald-500/30';
const DEST_KIND_REFUGE = 'text-cyan-300 bg-slate-900/80 border-cyan-500/30';

const SOURCE_BASE =
  'text-[9px] font-bold px-1.5 py-0.5 rounded border flex-shrink-0 mt-0.5 ';
const SOURCE_AI = 'text-brand-neon border-brand-neon/40 bg-emerald-950/40';
const SOURCE_FALLBACK = 'text-slate-400 border-slate-600 bg-slate-900';

/* ───────── DOM 도우미 ───────── */

function createIcon(paths, className, strokeWidth = '2') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', strokeWidth);
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = paths; // 고정 상수만 넣는다
  return svg;
}

function createEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function showToast(message, ms = TOAST_MS) {
  toastEl.textContent = message;
  toastEl.setAttribute('role', 'status');
  toastEl.classList.remove('hidden');
  clearTimeout(toastEl._hideTimer);
  toastEl._hideTimer = setTimeout(() => toastEl.classList.add('hidden'), ms);
}

/** 경로 요약 카드 안의 동적 안내 영역 (평면도 로딩 / 경로 계산 중 / 경로 없음) */
function getSummaryNotice() {
  let notice = summaryEl.querySelector('[data-role="summary-notice"]');
  if (!notice) {
    notice = createEl('div', 'hidden py-1');
    notice.dataset.role = 'summary-notice';
    summaryEl.append(notice);
  }
  return notice;
}

function floorLevelLabel(floor) {
  return Number(floor) < 0 ? `LEVEL B${-Number(floor)}` : `LEVEL ${floor}-F`;
}

/** 경로 중 현재 층에 연속으로 이어진 구간만 뽑는다. 다른 층 좌표를 이 층 평면도에 잇지 않기 위함. */
function pathRunOnFloor(path, floor) {
  const from = path.findIndex((node) => node.floor === floor);
  if (from < 0) return [];
  const run = [];
  for (let i = from; i < path.length && path[i].floor === floor; i++)
    run.push(path[i]);
  return run;
}

/* ───────── 구독: 상태 → 화면 ───────── */

function syncScreen(s) {
  const active = s.screen === SCREEN.PLAN;
  screenEl.classList.toggle('active', active);
  if (!active) {
    closeHelpModal({ restoreFocus: false });
    return;
  }
  // floorplan.js 가 이벤트 위임 중복 등록을 막는다
  initFloorplan({ onSelectRoom: handleSelectRoom });
  // 두 번 탭: 확대 ↔ 전체 보기 / 두 손가락 터치: 전체 보기
  bindZoomGestures(floorplanEl, {
    onDoubleTap: () => {
      cancelPendingSelect();
      if (isZoomed()) resetZoom();
      else zoomToCurrent(getState());
    },
    onTwoFinger: () => {
      cancelPendingSelect();
      resetZoom();
    },
  });

  drawPlan(s, []);
  focusFireBeforeSelection(s);
}

function scenarioOf(s) {
  return (s.scenarios || []).find((scenario) => scenario.key === s.scenarioKey) || null;
}

function fireOriginNode(s) {
  return nodeById(scenarioOf(s)?.origin_node);
}

/** 화면 데이터가 늦게 도착해도 경로 선택 전에는 화재 위치부터 보여준다. */
function focusFireBeforeSelection(s) {
  if (s.screen !== SCREEN.PLAN || s.route || isLoading('route')) return;
  const fireNode = fireOriginNode(s);
  if (!fireNode) return;
  if (Number(s.floor) !== Number(fireNode.floor)) {
    setFloor(fireNode.floor);
    return;
  }
  zoomToNodes([fireNode], { padding: 13, minWidth: 48 });
}

function visibleHazard(s) {
  const scenario = scenarioOf(s);
  const hazard = s.route?.hazard;
  return {
    fireId: scenario?.origin_node || null,
    blockedIds: hazard?.blocked_nodes || scenario?.blocked_nodes || [],
    smokeIds: hazard?.smoke_nodes || scenario?.smoke_nodes || [],
  };
}

/** 평면도: floorplan.js 가 요구하는 순서(층 → 위험 → 경로 → 현재지점)로 그린다. */
function drawPlan(s, changed) {
  planLevel.textContent = floorLevelLabel(s.floor);
  if (!s.building) return;

  if (changed.includes('floor')) clearPath(); // 이전 층 경로를 흐리게 남기지 않는다

  renderFloor({
    nodes: nodesOnFloor(s.floor),
    edges: edgesOnFloor(s.floor),
    floor: s.floor,
    // building.json 의 floor_images 에 이미지가 있으면 그 위에 경로를 그린다
    image: s.building.floor_images?.[String(s.floor)] ?? null,
  });
  renderHazard(visibleHazard(s));
  if (hasRoute() && !isImmobile(s)) renderPath(pathRunOnFloor(s.route.path, s.floor));
  else clearPath();
  markStart(s.route?.start?.id ?? s.startNodeId);

  // 현재 위치를 탭하면 그 주변(경로가 있으면 경로 전체)으로 확대한다
  if (changed.includes('route') || changed.includes('startNodeId')) {
    zoomToCurrent(s);
  }
}

/** 현재 경로(없으면 현재 위치) 주변으로 확대한다 */
function zoomToCurrent(s) {
  const onFloor = hasRoute() && !isImmobile(s) ? pathRunOnFloor(s.route.path, s.floor) : [];
  if (onFloor.length >= 2) {
    zoomToNodes(onFloor, { padding: 7, minWidth: 45 });
    return;
  }
  const here = nodeById(s.route?.start?.id ?? s.startNodeId);
  if (here && Number(here.floor) === Number(s.floor)) {
    zoomToNodes([here], { padding: 10, minWidth: 45 });
  }
}

function syncSummary(s) {
  const notice = getSummaryNotice();
  const show = (which) => {
    summaryEmpty.classList.toggle('hidden', which !== 'empty');
    summaryBody.classList.toggle('hidden', which !== 'body');
    notice.classList.toggle('hidden', which !== 'notice');
  };

  if (!s.building) {
    notice.replaceChildren(
      createEl(
        'p',
        'text-sm font-bold text-white text-center',
        '평면도를 불러오는 중…',
      ),
      createEl(
        'p',
        'text-[11px] text-slate-400 mt-1 text-center',
        '이 문구가 계속 보이면 새로고침해 주세요.',
      ),
    );
    show('notice');
  } else if (s.route && isImmobile(s)) {
    // 이동 불가: 목적지·거리 대신 '현재 위치에서 구조 대기'
    const route = s.route;
    destName.textContent = '현재 위치에서 구조 대기';
    destKind.textContent = '이동 불가';
    destKind.className = DEST_KIND_BASE + DEST_KIND_REFUGE;
    statDist.textContent = '0';
    statEta.textContent = '—';
    statStart.textContent = route.start?.name || '—';
    show('body');
  } else if (hasRoute()) {
    const route = s.route;
    destName.textContent = `${route.destination.floor}층 ${route.destination.name}`;
    destKind.textContent = destinationKindLabel();
    destKind.className =
      DEST_KIND_BASE +
      (route.destination_type === 'exit' ? DEST_KIND_EXIT : DEST_KIND_REFUGE);
    statDist.textContent = String(route.distance_m);
    statEta.textContent = etaLabel();
    statStart.textContent = route.start.name;
    show('body');
  } else if (isNoRoute()) {
    const route = s.route;
    const fallbackBox = createEl(
      'div',
      'mt-2 px-3 py-2 rounded-lg bg-amber-950/40 border border-amber-700/40',
    );
    fallbackBox.append(
      createEl(
        'p',
        'text-[10px] font-bold text-amber-400 mb-0.5',
        '지금 할 일',
      ),
      createEl(
        'p',
        'text-xs text-amber-100 leading-relaxed',
        route.fallback_action || '',
      ),
    );
    notice.replaceChildren(
      createEl(
        'p',
        'text-sm font-bold text-rose-300',
        '안전한 이동 경로를 찾지 못했습니다',
      ),
      createEl(
        'p',
        'text-[11px] text-slate-300 mt-1 leading-snug',
        route.reason || '',
      ),
      ...(route.start?.name
        ? [
            createEl(
              'p',
              'text-[11px] text-teal-300 mt-1',
              `현재 위치: ${route.start.name}`,
            ),
          ]
        : []),
      fallbackBox,
    );
    notice.setAttribute('role', 'alert');
    show('notice');
    return syncActionButtons(s);
  } else if (isLoading('route')) {
    notice.replaceChildren(
      createEl(
        'p',
        'text-sm font-bold text-white text-center py-2',
        '대피 경로를 계산하는 중…',
      ),
    );
    show('notice');
  } else {
    const scenario = currentScenario();
    const title = summaryEmpty.querySelector('p:first-child');
    const detail = summaryEmpty.querySelector('p:last-child');
    if (scenario?.origin_node) {
      title.textContent = `화재 발생: ${scenario.name}`;
      detail.textContent = '붉은 화재 지점을 확인한 뒤 평면도에서 현재 위치를 선택하세요.';
    } else {
      title.textContent = '평면도에서 현재 위치를 선택하세요';
      detail.textContent = '평면도에서 방을 탭하면 대피 경로가 계산됩니다.';
    }
    show('empty');
  }
  notice.removeAttribute('role');
  syncActionButtons(s);
}

function syncActionButtons(s) {
  startArBtn.disabled = !hasRoute();
  // 이동 불가는 AR 대피 안내를 하지 않는다
  startArBtn.style.display = isImmobile(s) ? 'none' : '';
  helpBtn.disabled = !s.route || isLoading('help'); // no_route 에서도 도움 요청은 가능해야 한다
  floorplanEl.setAttribute('aria-busy', String(isLoading('route')));
}

function syncGuide(s) {
  if (!s.route) {
    guideCard.classList.add('hidden');
    return;
  }

  if (isImmobile(s)) {
    renderGuide({ ...IMMOBILE_GUIDE, source: 'immobile' });
    return;
  }

  if (!s.guide) {
    if (!isLoading('guide')) {
      guideCard.classList.add('hidden');
      return;
    }
    guideHeadline.textContent = '행동요령을 준비하는 중…';
    guideSource.classList.add('hidden');
    guideSteps.replaceChildren();
    guideCautions.replaceChildren();
    guideCard.classList.remove('hidden');
    return;
  }

  renderGuide(s.guide);
}

/** 행동요령 카드를 그린다 */
function renderGuide(guide) {
  guideHeadline.textContent = guide.headline || '';

  guideSource.classList.remove('hidden');
  guideSource.textContent =
    guide.source === 'ai' ? 'AI 생성' : guide.source === 'immobile' ? '이동 불가 안내' : '기본 안내';
  guideSource.className =
    SOURCE_BASE + (guide.source === 'ai' ? SOURCE_AI : SOURCE_FALLBACK);

  guideSteps.replaceChildren(
    ...(guide.steps || []).map((step, i) => {
      const li = createEl(
        'li',
        'flex gap-2 text-xs text-slate-200 leading-relaxed',
      );
      li.append(
        createEl(
          'span',
          'flex-shrink-0 w-4 h-4 rounded-full bg-brand-neon/15 border border-brand-neon/40 text-brand-neon text-[9px] font-bold flex items-center justify-center mt-0.5',
          String(i + 1),
        ),
        createEl('span', '', step),
      );
      return li;
    }),
  );

  guideCautions.replaceChildren(
    ...(guide.cautions || []).filter(Boolean).map((caution) => {
      const p = createEl(
        'p',
        'flex gap-1.5 text-[11px] text-amber-300 leading-snug',
      );
      p.append(
        createIcon(WARNING_PATH, 'w-3 h-3 flex-shrink-0 mt-0.5'),
        createEl('span', '', caution),
      );
      return p;
    }),
  );

  guideCard.classList.remove('hidden');
}

function syncBadge(s) {
  badgeLabel.textContent = mobilityLabel();
  badgeIcon.replaceChildren(
    createIcon(ICON_PATHS[s.mobility] || ICON_PATHS.fallback, 'w-4 h-4'),
  );
}

function syncHazardChip(s) {
  const text = hazardChip.lastElementChild;
  if (!text) return;
  const scenario = scenarioOf(s);
  if (s.route?.hazard) {
    text.textContent = `차단 ${blockedNodeIds().length} · 연기 ${smokeNodeIds().length}`;
  } else if (scenario?.origin) {
    text.textContent = `화재 · ${scenario.origin}`;
  } else {
    text.textContent = '화재 위치 정보 없음';
  }
}

function syncEventButton() {
  const disabled = !nextPendingEvent() || isLoading('route');
  eventBtn.disabled = disabled;
  eventBtn.classList.toggle('opacity-40', disabled);
  eventBtn.classList.toggle('cursor-not-allowed', disabled);
}

subscribe(['screen'], syncScreen);
subscribe(['building', 'floor', 'route', 'startNodeId', 'scenarios', 'scenarioKey'], drawPlan);
subscribe(['building', 'route', 'loading', 'mobility', 'scenarios', 'scenarioKey'], syncSummary);
subscribe(['route', 'guide', 'loading', 'mobility'], syncGuide);
subscribe(['mobility', 'profiles', 'route'], syncBadge);
subscribe(['route', 'scenarios', 'scenarioKey'], syncHazardChip);
subscribe(['screen', 'building', 'scenarios', 'scenarioKey', 'floor'], focusFireBeforeSelection);
subscribe(
  ['scenarios', 'scenarioKey', 'triggeredEvents', 'loading'],
  syncEventButton,
);

/* ───────── 흐름 1: 경로 계산 ───────── */

async function handleSelectRoom(nodeId) {
  if (isLoading('route')) return; // 계산 중 중복 탭 방지
  // 같은 방을 다시 탭하면 재계산하지 않는다 (더블탭 줌 제스처와 겹치지 않게)
  if (nodeId === getState().startNodeId && getState().route) return;

  const s = getState();
  if (!s.mobility) {
    showToast('이동 상태를 먼저 선택해 주세요.');
    goScreen(SCREEN.MOBILITY);
    return;
  }

  const previousStart = s.startNodeId;
  selectStartNode(nodeId);
  setLoading('route', true);

  let route;
  try {
    route = await postRoute({
      mobility: s.mobility,
      startNode: nodeId,
      scenario: s.scenarioKey,
      events: s.triggeredEvents,
    });
  } catch (err) {
    console.error('[screen2] 경로 계산 요청 실패', err);
    setLoading('route', false);
    selectStartNode(previousStart); // 이전 화면 상태(경로·현재지점)를 그대로 둔다
    setError(err.message);
    showToast(err.message);
    return;
  }

  clearPath(); // 새 출발지의 경로는 이전 경로를 흐리게 남기지 않는다
  setRoute(route); // ok / no_route 모두 정상 응답. 분기는 구독 쪽 렌더러가 한다
  setLoading('route', false);

  await loadGuide(route); // 경로를 그린 뒤에 안내문
}

async function loadGuide(route) {
  if (isImmobile()) return; // 이동 불가는 고정 행동요령을 쓴다
  setLoading('guide', true);
  try {
    const guide = await postGuide(route);
    if (getState().route !== route) return; // 그사이 새 경로가 들어왔으면 버린다
    setGuide(guide);
  } catch (err) {
    if (getState().route !== route) return;
    console.error('[screen2] 행동요령 요청 실패', err);
    setGuide(null); // 안내문만 비우고 경로 표시는 유지
    showToast('행동요령을 불러오지 못했습니다. 경로 안내는 그대로 확인하세요.');
  } finally {
    if (getState().route === route) setLoading('guide', false);
  }
}

/* ───────── 흐름 2: 상황 변화 → 우회 재탐색 ───────── */

async function handleEvent() {
  if (isLoading('route')) return;

  const event = nextPendingEvent();
  if (!event) {
    showToast('추가 상황 변화가 없습니다');
    syncEventButton();
    return;
  }

  const s = getState();
  const currentNode = arCurrentNode()?.id ?? s.startNodeId;
  if (!currentNode) {
    showToast('먼저 평면도에서 현재 위치를 선택해 주세요.');
    return;
  }

  triggerEvent(event.id);
  setLoading('route', true);

  let route;
  try {
    route = await postReroute({
      mobility: s.mobility,
      currentNode,
      scenario: s.scenarioKey,
      events: s.triggeredEvents,
    });
  } catch (err) {
    console.error('[screen2] 우회 경로 재탐색 실패', err);
    setLoading('route', false);
    setError(err.message);
    showToast(
      `상황 변화를 반영한 경로를 계산하지 못했습니다. 현재 위치를 다시 탭해 주세요. (${err.message})`,
    );
    return;
  }

  setRoute(route); // renderPath 가 이전 경로를 흐리게 남긴다
  setLoading('route', false);

  // 경로가 바뀐 이유를 반드시 보여준다
  const reason = route.hazard?.reasons?.[0] || route.reason || event.label;
  showToast(reason, TOAST_MS);

  await loadGuide(route);
}

/* ───────── 흐름 3: 도움 요청 미리보기 ───────── */

async function handleHelp() {
  const route = getState().route;
  if (!route || isLoading('help')) return;

  setLoading('help', true);
  try {
    const result = await postHelpMessage(route);
    setHelpText(result.text);
    openHelpModal(result.text);
  } catch (err) {
    console.error('[screen2] 도움 요청 문구 생성 실패', err);
    showToast(`도움 요청 내용을 만들지 못했습니다. (${err.message})`);
  } finally {
    setLoading('help', false);
  }
}

function openHelpModal(text) {
  helpTextEl.textContent = text;
  helpModal.classList.remove('hidden');
  helpModal.classList.add('flex');
  helpModal.setAttribute('role', 'dialog');
  helpModal.setAttribute('aria-modal', 'true');
  helpCloseBtn.focus();
}

function closeHelpModal({ restoreFocus = true } = {}) {
  if (helpModal.classList.contains('hidden')) return;
  helpModal.classList.add('hidden');
  helpModal.classList.remove('flex');
  if (restoreFocus && !helpBtn.disabled) helpBtn.focus();
}

async function copyHelpText() {
  try {
    await navigator.clipboard.writeText(helpTextEl.textContent);
    showToast('내용이 복사되었습니다.');
  } catch (err) {
    console.error('[screen2] 클립보드 복사 실패', err);
    showToast('복사에 실패했습니다. 내용을 길게 눌러 직접 선택해 주세요.');
  }
}

function sendHelpKakao() {
  const text = helpTextEl.textContent.trim();
  if (!text) {
    showToast('전달할 도움 요청 내용이 없습니다.');
    return;
  }

  if (!window.Kakao?.isInitialized?.()) {
    showToast('카카오톡 공유 설정이 아직 완료되지 않았습니다.');
    return;
  }

  window.Kakao.Share.sendDefault({
    objectType: 'text',
    text,
    link: {
      mobileWebUrl: window.location.href,
      webUrl: window.location.href,
    },
  });
}

/* ───────── 이벤트 등록 ───────── */

badgeBtn.addEventListener('click', () => goScreen(SCREEN.MOBILITY));
eventBtn.addEventListener('click', handleEvent);
startArBtn.addEventListener('click', () => goScreen(SCREEN.AR)); // AR 로직은 screen3.js 담당
helpBtn.addEventListener('click', handleHelp);
helpCloseBtn.addEventListener('click', () => closeHelpModal());
helpCopyBtn.addEventListener('click', copyHelpText);
helpKakaoBtn.addEventListener('click', sendHelpKakao);
helpModal.addEventListener('click', (event) => {
  if (event.target === helpModal) closeHelpModal(); // 배경 클릭으로 닫기
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeHelpModal();
});

// 초기 표시 동기화 (상태를 바꾸지 않고, 현재 상태를 화면에 반영만 한다)
{
  const s = getState();
  drawPlan(s, []);
  syncSummary(s);
  syncGuide(s);
  syncBadge(s);
  syncHazardChip(s);
  syncEventButton();
}
