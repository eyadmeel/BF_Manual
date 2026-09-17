/**
 * screen1.js — 화면 1: 이동 상태 선택
 *
 * 역할: 이동 상태 카드 렌더링과 입력 처리, 상단 화재 경보 문구.
 *   - 상태는 state.js 의 action 으로만 바꾸고, 표시는 구독(subscribe)으로 동기화한다.
 *   - #screen1 의 .active 토글은 이 파일만 한다. 다른 화면 섹션은 건드리지 않는다.
 *   - 경로 계산은 화면 1의 책임이 아니다. api.postRoute 를 호출하지 않는다.
 *   - 개인정보를 받지 않고, 선택을 브라우저에 저장하지 않는다.
 */

import * as api from '../api.js';
import { ICON_PATHS } from '../icons.js';
import {
  SCREEN,
  getState,
  subscribe,
  goScreen,
  selectMobility,
  setProfiles,
  setScenarios,
  setBuilding,
  currentScenario,
} from '../state.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const screenEl = document.getElementById('screen1');
const gridEl = document.getElementById('mobility-grid');
const confirmBtn = document.getElementById('btn-confirm-mobility');
const alertEl = document.getElementById('alert-text');

const ALERT_FAILED = '화재 정보를 불러올 수 없습니다.';

// 선택 전에 "상태에 따라 목적지가 달라진다"는 차별점을 보여주는 문구
const DESTINATION_HINT = {
  exit: '1층 비상구로 안내',
  refuge: '같은 층 대피공간으로 안내',
};



const CARD_CLASS =
  'mobility-card rounded-2xl p-5 flex flex-col justify-between items-start text-left min-h-[210px] ' +
  'border active:scale-[.98] transition-all relative cursor-pointer select-none ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-neon';
const CARD_OFF = ['glass-card', 'border-slate-700/60'];
const CARD_ON = ['glass-card-active', 'border-2', 'border-brand-neon', 'shadow-neon-glow'];

const ICON_WRAP_OFF =
  'icon-wrap w-24 h-24 rounded-2xl bg-slate-800/80 flex items-center justify-center text-slate-300';
const ICON_WRAP_ON =
  'icon-wrap w-24 h-24 rounded-2xl bg-emerald-500/20 flex items-center justify-center text-brand-neon';

/* ───────── DOM 생성 도우미 ───────── */

function createIcon(paths, className, strokeWidth) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', strokeWidth);
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = paths; // 위의 고정 상수만 넣는다
  return svg;
}

function createCard(profile) {
  const card = document.createElement('div');
  card.className = `${CARD_CLASS} ${CARD_OFF.join(' ')}`;
  card.setAttribute('role', 'radio');
  card.setAttribute('aria-checked', 'false');
  card.setAttribute('tabindex', '-1');
  card.dataset.key = profile.key;

  const top = document.createElement('div');
  top.className = 'w-full flex items-center justify-center mb-3'; // 픽토그램 가운데 정렬

  const iconWrap = document.createElement('div');
  iconWrap.className = ICON_WRAP_OFF;
  iconWrap.append(
    createIcon(ICON_PATHS[profile.key] || ICON_PATHS.fallback, 'w-20 h-20', '2'),
  );

  // 선택 표시는 체크 아이콘 없이 카드 테두리 빛남(CARD_ON)으로만 한다
  top.append(iconWrap);

  const body = document.createElement('div');
  const title = document.createElement('h2');
  title.className = 'text-base font-bold text-slate-100 break-keep';
  title.textContent = profile.label || profile.key;
  const hint = document.createElement('p');
  hint.className = 'text-xs text-slate-400 mt-1 leading-snug break-keep';
  // 이동 불가는 이동하지 않고 제자리에서 구조를 기다리므로 문구를 따로 둔다
  hint.textContent =
    profile.key === 'need_help'
      ? '현재 위치에서 구조 대기 안내'
      : DESTINATION_HINT[profile.destination_type] || '안내 목적지 정보 없음';
  body.append(title, hint);

  card.append(top, body);
  return card;
}

/** 카드 자리에 한 줄 안내(불러오는 중/실패)를 그린다. withRetry 면 '다시 시도' 버튼을 붙인다. */
function renderGridMessage(message, { withRetry = false } = {}) {
  const box = document.createElement('div');
  box.className =
    'col-span-2 flex flex-col items-center justify-center gap-3 py-8 px-4 rounded-2xl border border-slate-700/60 glass-card text-center';

  const text = document.createElement('p');
  text.className = 'text-xs text-slate-300';
  text.setAttribute('role', withRetry ? 'alert' : 'status');
  text.textContent = message;
  box.append(text);

  if (withRetry) {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.dataset.action = 'retry-mobility';
    retry.className =
      'px-4 py-2 rounded-xl bg-brand-neon text-slate-950 text-xs font-black active:scale-[.98] transition-all';
    retry.textContent = '다시 시도';
    box.append(retry);
  }

  gridEl.replaceChildren(box);
}

function renderCards(profiles) {
  gridEl.replaceChildren(...profiles.map(createCard));
  // 다시 그린 카드에도 현재 선택을 반영한다 (화면 2에서 되돌아온 경우 등)
  syncSelection(getState());
}

/** 강조 마크업([화재 경보])은 유지하고 그 뒤의 문구만 textContent 로 교체한다. */
function setAlertMessage(message) {
  const strong = alertEl.querySelector('strong');
  if (!strong) {
    alertEl.textContent = `[화재 경보] ${message}`;
  } else {
    [...alertEl.childNodes].forEach((node) => {
      if (node !== strong) node.remove();
    });
    alertEl.append(document.createTextNode(message));
  }
  alertEl.setAttribute('title', message); // 한 줄로 잘릴 때 전체 문구 확인용
}

/* ───────── 구독: 상태 → 화면 동기화 ───────── */

function syncScreen(s) {
  screenEl.classList.toggle('active', s.screen === SCREEN.MOBILITY);
}

function syncSelection(s) {
  const cards = [...gridEl.querySelectorAll('[role="radio"][data-key]')];
  const selectedKey = s.mobility;

  for (const card of cards) {
    const on = card.dataset.key === selectedKey;
    card.setAttribute('aria-checked', String(on));
    card.classList.remove(...(on ? CARD_OFF : CARD_ON));
    card.classList.add(...(on ? CARD_ON : CARD_OFF));

    card.querySelector('.icon-wrap').className = on
      ? ICON_WRAP_ON
      : ICON_WRAP_OFF;
  }

  // 로빙 tabindex: 선택된 카드(없으면 첫 카드)만 Tab 순서에 들어간다
  const focusable =
    cards.find((card) => card.dataset.key === selectedKey) || cards[0];
  cards.forEach((card) =>
    card.setAttribute('tabindex', card === focusable ? '0' : '-1'),
  );

  confirmBtn.disabled = !selectedKey;
}

function syncAlert(s) {
  const scenario = currentScenario();
  if (!scenario) {
    console.error(
      `[screen1] 시나리오 '${s.scenarioKey}' 를 응답에서 찾을 수 없습니다.`,
    );
    setAlertMessage(ALERT_FAILED);
    return;
  }
  setAlertMessage(
    scenario.origin ? `${scenario.name} — ${scenario.origin}` : scenario.name,
  );
}

subscribe(['screen'], syncScreen);
subscribe(['mobility'], syncSelection);
subscribe(['scenarios', 'scenarioKey'], syncAlert);

/* ───────── 입력 처리 (이벤트 위임 1회) ───────── */

gridEl.addEventListener('click', (event) => {
  if (event.target.closest('[data-action="retry-mobility"]')) {
    loadProfiles();
    return;
  }
  const card = event.target.closest('[role="radio"][data-key]');
  if (card) selectMobility(card.dataset.key);
});

gridEl.addEventListener('keydown', (event) => {
  const card = event.target.closest('[role="radio"][data-key]');
  if (!card) return;

  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    selectMobility(card.dataset.key);
    return;
  }

  // 라디오 그룹 관례: 방향키로 이동하면서 선택
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[
    event.key
  ];
  if (!step) return;
  event.preventDefault();
  const cards = [...gridEl.querySelectorAll('[role="radio"][data-key]')];
  const next =
    cards[(cards.indexOf(card) + step + cards.length) % cards.length];
  selectMobility(next.dataset.key);
  next.focus();
});

/**
 * AR 카메라 권한을 미리 받는다.
 * 브라우저 규칙상 권한 요청은 버튼 클릭 같은 사용자 동작 안에서만 가능하므로
 * '다음' 버튼에서 한 번 요청한다. 권한만 받고 카메라는 바로 끈다.
 * 거부하거나 실패해도 앱 흐름은 막지 않는다. (AR 화면은 카메라 없이도 안내)
 */
async function requestCameraPermissionOnce() {
  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return;
    const status = await navigator.permissions?.query({ name: 'camera' }).catch(() => null);
    if (status && status.state !== 'prompt') return; // 이미 허용 또는 거부됨
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
    stream.getTracks().forEach((t) => t.stop());
  } catch (err) {
    console.info('[screen1] 카메라 권한을 받지 못했습니다. AR 은 카메라 없이 안내합니다.', err?.name);
  }
}

confirmBtn.addEventListener('click', () => {
  if (!getState().mobility) return;
  requestCameraPermissionOnce(); // 기다리지 않는다: 권한 창이 떠 있어도 화면은 넘어간다
  goScreen(SCREEN.PLAN);
});

/* ───────── 초기 데이터 ───────── */

async function loadProfiles() {
  renderGridMessage('이동 상태를 불러오는 중…');
  try {
    const profiles = await api.getMobility();
    if (!Array.isArray(profiles) || profiles.length === 0) {
      throw new Error('이동 상태 목록이 비어 있습니다.');
    }
    setProfiles(profiles);
    renderCards(profiles);
  } catch (err) {
    console.error('[screen1] 이동 상태 목록을 불러오지 못했습니다.', err);
    renderGridMessage('이동 상태 목록을 불러오지 못했습니다.', {
      withRetry: true,
    });
  }
}

async function loadScenarios() {
  try {
    setScenarios(await api.getScenarios());
  } catch (err) {
    console.error('[screen1] 시나리오를 불러오지 못했습니다.', err);
    setAlertMessage(ALERT_FAILED);
  }
}

async function loadBuilding() {
  // 화면 2 진입 시 로딩을 없애기 위한 선행 fetch. 실패하면 화면 2가 처리한다.
  try {
    setBuilding(await api.getBuilding());
  } catch (err) {
    console.error('[screen1] 평면도 데이터를 미리 받지 못했습니다.', err);
  }
}

// 각 호출은 도착하는 대로 그리고, 하나가 실패해도 나머지는 계속된다
Promise.allSettled([loadProfiles(), loadScenarios(), loadBuilding()]);
