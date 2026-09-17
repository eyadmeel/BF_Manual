/**
 * icons.js — 이동 상태 픽토그램 (화면1 카드, 화면2 이동 상태 배지 공용)
 * 고정 상수 문자열만 둔다. stroke + currentColor, 요소별 선 굵기 지정.
 */

export const ICON_PATHS = {
  // 걷는 사람
  independent:
    '<circle cx="12.3" cy="4.2" r="1.9" fill="currentColor" stroke="none"/><path d="M12.4 8v5.6" stroke-width="3.4"/><path d="M11 8.2L8.4 10.2 7.2 13M13.7 8.3l.9 2.6 2.7 1.8M12.2 13.6l4.3 6.7 1.8-.6M10.8 15.6l-4.4 5 1.8.7" stroke-width="2.4"/>',
  // 지팡이를 짚은 사람
  walking_aid:
    '<circle cx="12.4" cy="4.5" r="1.8" fill="currentColor" stroke="none"/><path d="M12.4 8.3v5.3" stroke-width="4.4"/><path d="M11.3 13.5v7.1M13.5 13.5v7.1" stroke-width="1.9"/><path d="M10.2 8.2L9.3 12.4M14.7 8.2l.6 5" stroke-width="1.8"/><path d="M8 12.6h1.5M8.9 13l-1.6 8.1" stroke-width="1"/>',
  // 휠체어
  wheelchair:
    '<circle cx="10.2" cy="5" r="2" fill="currentColor" stroke="none"/><path d="M10 8.8v5.2" stroke-width="3.2"/><path d="M10.2 14.3h5l2.6 5.2 2.1-1.1" stroke-width="2.6"/><path d="M11 11.4h4.4" stroke-width="1.6"/><path d="M7.8 11.9A5 5 0 1 0 15.2 17.8" stroke-width="1.3"/>',
  // 이동 불가: 흰색 금지 표시 (선택 여부와 관계없이 흰색 고정)
  need_help:
    '<circle cx="12" cy="12" r="9" stroke="#ffffff" stroke-width="3"/><path d="M5.6 5.6l12.8 12.8" stroke="#ffffff" stroke-width="3" stroke-linecap="butt"/>',
  // 알 수 없는 key 용 기본 아이콘
  fallback:
    '<circle cx="12" cy="6" r="2.5"/><path d="M7 21v-6a5 5 0 0110 0v6"/>',
};
