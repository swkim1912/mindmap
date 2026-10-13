/** 툴바 등 캔버스 밖에서 화면 맞춤/확대를 호출하기 위한 핸들 (MapCanvas가 채운다) */
export const canvasControls = {
  fit: () => {},
  zoomBy: (_factor: number) => {},
};

/** 선택된 노드의 키 입력 수신기(숨은 textarea)로 포커스를 되돌린다 */
export function focusSink() {
  // requestAnimationFrame 은 화면이 가려져 있으면 멈추므로 setTimeout 을 쓴다
  setTimeout(() => document.querySelector<HTMLTextAreaElement>('textarea[data-sink]')?.focus({ preventScroll: true }), 0);
}
