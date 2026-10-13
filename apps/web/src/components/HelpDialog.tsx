import { useStore } from '../store';

const SHORTCUTS: [string, string][] = [
  ['하위 주제 추가', 'Tab'],
  ['동급 주제 추가 (아래 / 위)', 'Enter / Shift+Enter'],
  ['부모 주제 삽입', 'Ctrl+Enter'],
  ['편집', 'F2, Space, 더블클릭, 또는 바로 타이핑'],
  ['편집 확정 / 취소', 'Enter / Esc'],
  ['편집 중 줄바꿈', 'Shift+Enter'],
  ['삭제', 'Delete / Backspace'],
  ['주제 이동 (선택)', '방향키'],
  ['순서 위 / 아래로', 'Alt+↑ / Alt+↓'],
  ['접기 / 펼치기', 'Ctrl+/'],
  ['여러 개 선택', 'Ctrl+클릭, Shift+클릭'],
  ['복사 / 잘라내기 / 붙여넣기', 'Ctrl+C / Ctrl+X / Ctrl+V'],
  ['중심 주제로', 'Home'],
  ['저장', 'Ctrl+S (자동 저장도 됨)'],
  ['실행 취소 / 다시 실행', 'Ctrl+Z / Ctrl+Y'],
  ['화면 맞춤', 'Ctrl+0'],
  ['확대 / 축소', 'Ctrl+= / Ctrl+-, Ctrl+휠'],
  ['화면 이동', '배경 드래그, 휠'],
  ['단축키 도움말', 'F1, Ctrl+?'],
];

export function HelpDialog() {
  const open = useStore((s) => s.helpOpen);
  if (!open) return null;
  const close = () => useStore.getState().setHelp(false);
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="단축키">
        <div className="modal-head">
          <h2>단축키</h2>
          <button onClick={close} aria-label="닫기">✕</button>
        </div>
        <table className="shortcuts">
          <tbody>
            {SHORTCUTS.map(([what, keys]) => (
              <tr key={what}>
                <td>{what}</td>
                <td>
                  <kbd>{keys}</kbd>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hint">
          노드 문법: <code>**굵게**</code> <code>==빈칸==</code> <code>$수식$</code> <code>질문 :: 답</code>{' '}
          <code>[[링크]]</code>
        </p>
      </div>
    </div>
  );
}
