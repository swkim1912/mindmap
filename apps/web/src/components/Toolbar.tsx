import { getLayout, type LayoutKind } from '@mindmap/core';
import { useStore } from '../store';
import { useAux } from '../workspace';
import { useStudy } from '../study';
import { commands } from '../commands';
import { canvasControls } from '../controls';
import { useUi } from '../ui';

const SAVE_LABEL = { saved: '저장됨', dirty: '저장 대기', saving: '저장 중…', error: '저장 오류' } as const;

/** 툴바 버튼은 포커스를 가져가지 않게 해서 맵 단축키가 계속 동작하도록 한다 */
const noFocus = (e: React.MouseEvent) => e.preventDefault();

function DrawerButton() {
  return (
    <button className="drawer-btn" onClick={() => useUi.getState().setDrawer(true)} title="맵 목록">
      ☰
    </button>
  );
}

export function Toolbar() {
  const map = useStore((s) => s.map);
  const saveState = useStore((s) => s.saveState);
  const canUndo = useStore((s) => s.undoStack.length > 0);
  const canRedo = useStore((s) => s.redoStack.length > 0);
  const canBack = useAux((s) => s.navStack.length > 0);
  const notesOpen = useAux((s) => s.openNotes.length > 0);
  const fileBacklinks = useAux((s) => s.backlinks?.file.length ?? 0);
  const hiding = useStudy((s) => s.hide !== null);
  if (!map) return <header className="toolbar only-narrow"><DrawerButton /></header>;

  const layout = getLayout(map.doc);
  const setLayout = (l: LayoutKind) =>
    useStore.getState().apply((d) => {
      d.meta.layout = l;
    });
  const segs = map.path.replace(/\.mm\.md$/, '').split('/');

  return (
    <header className="toolbar" onMouseDown={noFocus}>
      <DrawerButton />
      <button onClick={() => void useAux.getState().back()} disabled={!canBack} title="이전 위치로 (Alt+←)">
        ←
      </button>
      <div className="crumbs" title={map.path}>
        {segs.map((seg, i) => (
          <span key={i} className={i === segs.length - 1 ? 'crumb-last' : 'crumb'}>
            {seg}
          </span>
        ))}
      </div>
      <div className="tb-group desk">
        <button onClick={() => commands.addChild()} disabled={hiding} title="하위 주제 (Tab)">하위 ＋</button>
        <button onClick={() => commands.addSibling()} disabled={hiding} title="동급 주제 (Enter)">동급 ＋</button>
        <button onClick={() => useStore.getState().undo()} disabled={!canUndo || hiding} title="실행 취소 (Ctrl+Z)">↶</button>
        <button onClick={() => useStore.getState().redo()} disabled={!canRedo || hiding} title="다시 실행 (Ctrl+Y)">↷</button>
      </div>
      <div className="tb-group desk">
        <button onClick={() => useAux.getState().toggleNote(useStore.getState().primary!)} title="선택한 노드에 메모 (F4)">
          📌 메모
        </button>
        <button
          className={notesOpen ? 'on-soft' : ''}
          onClick={() => useAux.getState().setAllNotes(!notesOpen)}
          title="모든 메모 열기/닫기 (Shift+F4)"
        >
          {notesOpen ? '메모 모두 닫기' : '메모 모두 열기'}
        </button>
        <button onClick={() => void useAux.getState().openOrCreatePage(useStore.getState().primary!)} title="상세 페이지 열기/만들기 (Ctrl+E)">
          📄 페이지
        </button>
      </div>
      <div className="tb-group">
        <button
          className={hiding ? 'on-soft' : ''}
          onClick={() => (hiding ? useStudy.getState().exitHide() : useStudy.getState().enterHide())}
          title="선택한 노드 아래를 가리고 하나씩 떠올려 보기 (F8)"
        >
          🙈 가리기
        </button>
        <button onClick={() => void useStudy.getState().openSetup()} title="질문 :: 답 / ==빈칸== 을 카드로 복습">
          🃏 카드
        </button>
      </div>
      <div className="tb-group segmented">
        <button className={layout === 'mindmap' ? 'on' : ''} onClick={() => setLayout('mindmap')} disabled={hiding} title="중심에서 좌우로">
          마인드맵
        </button>
        <button className={layout === 'logic-right' ? 'on' : ''} onClick={() => setLayout('logic-right')} disabled={hiding} title="오른쪽으로 펼침">
          로직 차트
        </button>
      </div>
      <div className="tb-group">
        <button onClick={() => canvasControls.zoomBy(1 / 1.2)} title="축소 (Ctrl+-)">−</button>
        <button onClick={() => canvasControls.fit()} title="화면 맞춤 (Ctrl+0)">맞춤</button>
        <button onClick={() => canvasControls.zoomBy(1.2)} title="확대 (Ctrl+=)">＋</button>
      </div>
      <div className="tb-spacer" />
      {fileBacklinks > 0 && (
        <button onClick={() => useAux.getState().openBacklinks(null)} title="이 맵을 가리키는 곳">
          ↩ {fileBacklinks}
        </button>
      )}
      <button onClick={() => useAux.getState().openSearch()} title="검색 (Ctrl+P)">
        🔍
      </button>
      {map.warnings.length > 0 && (
        <span className="warn-chip" title={map.warnings.map((w) => `${w.line}행: ${w.message}`).join('\n')}>
          ⚠ 해석 경고 {map.warnings.length}
        </span>
      )}
      <button className={`save-state ${saveState}`} onClick={() => void useStore.getState().save()} title="저장 (Ctrl+S)">
        {SAVE_LABEL[saveState]}
      </button>
      <button onClick={() => useStore.getState().setHelp(true)} title="단축키 (F1)">
        ?
      </button>
    </header>
  );
}
