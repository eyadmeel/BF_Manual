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
} from '../floorplan.js';
import {
  SCREEN,
  getState,
  subscribe,
  goScreen,
  setRoute,
  setGuide,
  setHelpText,
  setLoading,
  isLoading,
  setError,
  selectStartNode,
  triggerEvent,
  nextPendingEvent,
  nodesOnFloor,
  edgesOnFloor,
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

// screen1 과 같은 이동 상태 아이콘 (고정 상수, stroke + currentColor)
const ICON_PATHS = {
  independent:
    '<circle cx="13.5" cy="4.5" r="2"/><path d="M6 18l3-3 2 1.5 3-4-2.5-3.5 3-2"/><path d="M10 21l2-4.5-1.5-2"/><path d="M5 12l3-1.5"/>',
  walking_aid:
    '<path d="M16 4a2 2 0 00-4 0v16"/><path d="M8 8a2 2 0 014 0"/><circle cx="6.5" cy="5.5" r="1.5"/><path d="M5 20l2.5-9L11 12"/>',
  wheelchair:
    '<circle cx="12" cy="4" r="2"/><path d="M12 6v6h4"/><path d="M8 12a4 4 0 104 4"/><path d="M15 19l4 2"/>',
  need_help:
    '<path d="M8 12.5V6a1.5 1.5 0 013 0v5"/><path d="M11 10.5V4.5a1.5 1.5 0 013 0v6"/><path d="M14 10.5V6a1.5 1.5 0 013 0v7"/><path d="M8 11a1.5 1.5 0 00-3 0v3.5A6.5 6.5 0 0011.5 21h1a4.5 4.5 0 004.5-4.5V13"/><path d="M3.5 5.5L2 4M4 2.5L3.5 1"/>',
  fallback:
    '<circle cx="12" cy="6" r="2.5"/><path d="M7 21v-6a5 5 0 0110 0v6"/>',
};
const WARNING_PATH =
  '<path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>';

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
  drawPlan(s, []);
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
  renderHazard({ blockedIds: blockedNodeIds(), smokeIds: smokeNodeIds() });
  if (hasRoute()) renderPath(pathRunOnFloor(s.route.path, s.floor));
  else clearPath();
  markStart(s.route?.start?.id ?? s.startNodeId);
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
    show('empty');
  }
  notice.removeAttribute('role');
  syncActionButtons(s);
}

function syncActionButtons(s) {
  startArBtn.disabled = !hasRoute();
  helpBtn.disabled = !s.route || isLoading('help'); // no_route 에서도 도움 요청은 가능해야 한다
  floorplanEl.setAttribute('aria-busy', String(isLoading('route')));
}

function syncGuide(s) {
  if (!s.route) {
    guideCard.classList.add('hidden');
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

  const guide = s.guide;
  guideHeadline.textContent = guide.headline || '';

  guideSource.classList.remove('hidden');
  guideSource.textContent = guide.source === 'ai' ? 'AI 생성' : '기본 안내';
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
  text.textContent = s.route?.hazard
    ? `차단 ${blockedNodeIds().length} · 연기 ${smokeNodeIds().length}`
    : '위치 선택 후 위험 정보 표시';
}

function syncEventButton() {
  const disabled = !nextPendingEvent() || isLoading('route');
  eventBtn.disabled = disabled;
  eventBtn.classList.toggle('opacity-40', disabled);
  eventBtn.classList.toggle('cursor-not-allowed', disabled);
}

subscribe(['screen'], syncScreen);
subscribe(['building', 'floor', 'route', 'startNodeId'], drawPlan);
subscribe(['building', 'route', 'loading'], syncSummary);
subscribe(['route', 'guide', 'loading'], syncGuide);
subscribe(['mobility', 'profiles', 'route'], syncBadge);
subscribe(['route'], syncHazardChip);
subscribe(
  ['scenarios', 'scenarioKey', 'triggeredEvents', 'loading'],
  syncEventButton,
);

/* ───────── 흐름 1: 경로 계산 ───────── */

async function handleSelectRoom(nodeId) {
  if (isLoading('route')) return; // 계산 중 중복 탭 방지

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
