import { useMemo } from 'react';
import { findNode, hideItems, plainLine } from '@mindmap/core';
import { useStore } from '../store';
import { useStudy } from '../study';

/** 가리기 모드 중 맵 위쪽에 보이는 안내/조작 줄 */
export function HideBar() {
  const hide = useStudy((s) => s.hide);
  const doc = useStore((s) => s.map?.doc);
  const scopeId = hide?.scopeId;
  const scopeText = useMemo(
    () => (doc && scopeId ? plainLine(findNode(doc.root, scopeId)?.text ?? '') : ''),
    [doc, scopeId],
  );
  const items = useMemo(() => (hide && doc ? hideItems(doc, hide.scopeId) : []), [hide?.scopeId, doc]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!hide) return null;

  const done = items.filter((i) => hide.revealed.has(i.key)).length;
  const st = useStudy.getState();
  const noFocus = (e: React.MouseEvent) => e.preventDefault();

  return (
    <div className="hide-bar" onMouseDown={noFocus}>
      <strong>🙈 가리기 모드</strong>
      <span className="hide-scope" title={scopeText}>
        “{scopeText || '맵 전체'}” 아래
      </span>
      <span className="hide-progress">
        {done}/{items.length} 공개
      </span>
      <progress value={done} max={Math.max(items.length, 1)} />
      <span className="tb-spacer" />
      <span className="hint">클릭: 보기 ↔ 다시 가리기 · Space: 다음 보기 · Shift+Space: 모두 보기</span>
      <button onClick={() => st.revealNext(useStore.getState().primary)} title="다음 항목 보기 (Space)">
        다음 보기
      </button>
      <button onClick={() => st.revealAll()} title="모두 드러내기 (Shift+Space)">
        모두 보기
      </button>
      <button onClick={() => st.resetHide()} title="처음부터 다시 연습">
        다시 가리기
      </button>
      <button className="primary" onClick={() => st.exitHide()} title="가리기 모드 종료 (Esc)">
        종료
      </button>
    </div>
  );
}
