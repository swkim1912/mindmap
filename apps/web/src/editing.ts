/**
 * 진행 중인 노드 텍스트 편집을 확정하는 함수. 편집기가 등록하고,
 * 선택 변경/저장/맵 전환 등 다른 동작 전에 호출해 입력 내용이 사라지지 않게 한다.
 */
let committer: (() => void) | null = null;

export function registerCommitter(fn: (() => void) | null) {
  committer = fn;
}

export function flushEdit() {
  committer?.();
}
