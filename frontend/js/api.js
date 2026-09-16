/**
 * api.js — 백엔드(Flask /api) 호출 전용 모듈.
 *
 * 원칙: 이 파일은 상태를 다루지 않는다.
 *   - state.js를 import하지 않고, DOM도 만지지 않는다.
 *   - 각 함수는 요청을 보내고 백엔드 응답(JSON)을 가공 없이 그대로 반환한다.
 *   - 재시도하지 않는다. 화재 상황 UI에서는 지연이 더 위험하다.
 *
 * 주의: /route, /reroute는 경로를 못 찾아도 HTTP 200으로
 *   { status: "no_route", reason, fallback_action, ... }을 반환한다.
 *   이는 오류가 아니므로 throw하지 않는다. status 판별은 화면 모듈의 몫이다.
 *
 * 프론트는 Flask가 같은 오리진에서 서빙하므로 상대경로를 쓴다.
 */

const BASE_URL = '/api';

/** GET /api/config — 프론트엔드 공개 설정 */
export function getConfig() {
  return request('/config');
}
const TIMEOUT_MS = 8000;

/**
 * 공통 요청 헬퍼.
 * - 8초 안에 응답(본문 포함)이 끝나지 않으면 중단한다.
 * - HTTP 오류는 본문의 error 필드를 메시지로, status 속성을 붙여 throw한다.
 */
async function request(path, { method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    let res;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) throw new Error('서버 응답이 없습니다. 잠시 후 다시 시도하세요.');
      throw new Error('서버에 연결할 수 없습니다.', { cause: err });
    }

    let data;
    try {
      data = await res.json();
    } catch (err) {
      // 본문을 읽는 도중 타임아웃이 난 경우
      if (controller.signal.aborted) throw new Error('서버 응답이 없습니다. 잠시 후 다시 시도하세요.');
      data = undefined;
    }

    if (!res.ok) {
      const message = data && typeof data.error === 'string' && data.error
        ? data.error
        : `요청 실패 (HTTP ${res.status})`;
      const error = new Error(message);
      error.status = res.status;
      throw error;
    }

    if (data === undefined) {
      const error = new Error(`요청 실패 (HTTP ${res.status})`);
      error.status = res.status;
      throw error;
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** GET /api/health */
export function getHealth() {
  return request('/health');
}

/** GET /api/building — 노드·엣지·층·시설 정보 */
export function getBuilding() {
  return request('/building');
}

/** GET /api/mobility — 이동 상태 선택지 */
export function getMobility() {
  return request('/mobility');
}

/** GET /api/scenarios — 시연 시나리오와 이벤트 목록 */
export function getScenarios() {
  return request('/scenarios');
}

/**
 * POST /api/route — 경로 계산.
 * no_route도 정상 응답으로 그대로 반환한다.
 */
export function postRoute({ mobility, startNode, scenario, events = [] }) {
  return request('/route', {
    method: 'POST',
    body: { mobility, start_node: startNode, scenario, events },
  });
}

/**
 * POST /api/reroute — 이동 중 상황 변화 시 현재 노드 기준 재탐색.
 * no_route도 정상 응답으로 그대로 반환한다.
 */
export function postReroute({ mobility, currentNode, scenario, events = [] }) {
  return request('/reroute', {
    method: 'POST',
    body: { mobility, current_node: currentNode, scenario, events },
  });
}

/** POST /api/guide — 계산된 경로를 행동요령으로 변환 (느림: 경로를 먼저 그린 뒤 호출) */
export function postGuide(route) {
  return request('/guide', {
    method: 'POST',
    body: { route },
  });
}

/** POST /api/help-message — 도움 요청 미리보기 문구 */
export function postHelpMessage(route, note = '') {
  return request('/help-message', {
    method: 'POST',
    body: { route, note },
  });
}

/** POST /api/dev/reload — JSON 수정 후 서버 캐시 비우기 (개발용) */
export function devReload() {
  return request('/dev/reload', { method: 'POST' });
}
