import { useStore } from '../store';
import { useAux } from '../workspace';
import { useStudy } from '../study';
import { commands } from '../commands';

/**
 * 키보드가 없는 화면(휴대폰·태블릿)용 하단 조작 줄.
 * 좁거나 터치 중심인 화면에서만 CSS 로 보인다.
 */
export function MobileBar() {
  const canUndo = useStore((s) => s.undoStack.length > 0);
  const canRedo = useStore((s) => s.redoStack.length > 0);
  const hiding = useStudy((s) => s.hide !== null);
  const editing = useStore((s) => s.editing !== null);
  const hasPrimary = useStore((s) => s.primary !== null);
  if (hiding || editing) return null;
  // 버튼이 포커스를 가져가지 않게 한다 (편집 중인 입력창이 닫히지 않도록)
  const noFocus = (e: React.PointerEvent) => e.preventDefault();
  return (
    <nav className="mobile-bar" onPointerDown={noFocus} aria-label="편집 도구">
      <button disabled={!hasPrimary} onClick={() => commands.edit()}>✎<small>편집</small></button>
      <button disabled={!hasPrimary} onClick={() => commands.addChild()}>⤷<small>하위</small></button>
      <button disabled={!hasPrimary} onClick={() => commands.addSibling()}>↓<small>동급</small></button>
      <button disabled={!hasPrimary} onClick={() => commands.remove()}>🗑<small>삭제</small></button>
      <button disabled={!hasPrimary} onClick={() => useAux.getState().toggleNote(useStore.getState().primary!)}>📌<small>메모</small></button>
      <button disabled={!hasPrimary} onClick={() => void useAux.getState().openOrCreatePage(useStore.getState().primary!)}>📄<small>페이지</small></button>
      <button disabled={!hasPrimary} onClick={() => commands.toggleCollapse()}>⇕<small>접기</small></button>
      <button disabled={!canUndo} onClick={() => useStore.getState().undo()}>↶<small>취소</small></button>
      <button disabled={!canRedo} onClick={() => useStore.getState().redo()}>↷<small>다시</small></button>
    </nav>
  );
}
