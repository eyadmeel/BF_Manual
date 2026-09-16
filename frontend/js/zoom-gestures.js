/**
 * zoom-gestures.js — 지도 확대/축소 제스처 (화면2 평면도, 화면3 경로 지도 공용)
 *
 *   - 두 번 탭(더블탭): 확대 ↔ 전체 보기 전환
 *   - 두 손가락 터치(핀치·두 손가락 이동): 전체 보기로 축소
 *
 * 한 손가락 스크롤은 막지 않는다. 브라우저 자체 핀치 확대만 막는다.
 * 상태를 두지 않고, 무엇을 할지는 호출하는 화면이 콜백으로 정한다.
 */

const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_PX = 30;

/**
 * @param {Element} el
 * @param {{ onDoubleTap: () => void, onTwoFinger: () => void }} handlers
 */
export function bindZoomGestures(el, { onDoubleTap, onTwoFinger }) {
  if (!el || el.dataset.zoomGestures === 'true') return;
  el.dataset.zoomGestures = 'true';
  el.style.touchAction = 'pan-x pan-y'; // 한 손가락 스크롤 허용, 브라우저 핀치 확대 차단

  let lastTap = { t: 0, x: 0, y: 0 };
  let twoFingerFired = false;
  let lastToggleAt = 0;

  const fireDoubleTap = () => {
    const now = Date.now();
    if (now - lastToggleAt < 400) return; // 터치 더블탭 뒤 dblclick 이 한 번 더 오는 것 방지
    lastToggleAt = now;
    onDoubleTap?.();
  };

  el.addEventListener('touchstart', (e) => {
    if (e.touches.length >= 2) {
      e.preventDefault();
      if (!twoFingerFired) {
        twoFingerFired = true;
        lastTap.t = 0;
        onTwoFinger?.();
      }
    }
  }, { passive: false });

  el.addEventListener('touchmove', (e) => {
    if (e.touches.length >= 2) e.preventDefault(); // 두 손가락 제스처는 페이지로 넘기지 않는다
  }, { passive: false });

  el.addEventListener('touchend', (e) => {
    if (e.touches.length === 0) {
      const wasTwo = twoFingerFired;
      twoFingerFired = false;
      if (wasTwo || e.changedTouches.length !== 1) return;
    } else {
      return;
    }
    const t = e.changedTouches[0];
    const now = Date.now();
    const near = Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) < DOUBLE_TAP_PX;
    if (now - lastTap.t < DOUBLE_TAP_MS && near) {
      lastTap.t = 0;
      e.preventDefault(); // 두 번째 탭이 방 선택으로 이어지지 않게
      fireDoubleTap();
    } else {
      lastTap = { t: now, x: t.clientX, y: t.clientY };
    }
  }, { passive: false });

  // 데스크톱(마우스) 더블클릭
  el.addEventListener('dblclick', (e) => {
    e.preventDefault();
    fireDoubleTap();
  });
}
