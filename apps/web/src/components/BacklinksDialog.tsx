import { findNode } from '@mindmap/core';
import { useAux } from '../workspace';
import { useStore } from '../store';
import type { BacklinkSource } from '../types';

export function BacklinksDialog() {
  const dialog = useAux((s) => s.dialog);
  const nodeId = useAux((s) => s.backlinkNode);
  const backlinks = useAux((s) => s.backlinks);
  const map = useStore((s) => s.map);
  if (dialog !== 'backlinks' || !map) return null;

  const close = () => useAux.getState().closeDialog();
  const sources: BacklinkSource[] = nodeId ? (backlinks?.nodes[nodeId] ?? []) : (backlinks?.file ?? []);
  const nodeText = nodeId ? findNode(map.doc.root, nodeId)?.text.split('\n')[0] : null;

  const go = (s: BacklinkSource) => {
    close();
    if (s.kind === 'page') void useAux.getState().openPage(s.path);
    else void useAux.getState().goMap(s.path, s.nodeId);
  };

  return (
    <div className="modal-backdrop" onMouseDown={close} onKeyDown={(e) => e.key === 'Escape' && close()}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="역링크">
        <div className="modal-head">
          <h2>이 {nodeId ? '노드' : '맵'}를 가리키는 곳</h2>
          <button onClick={close} aria-label="닫기" autoFocus>
            ✕
          </button>
        </div>
        {nodeText && <p className="hint">“{nodeText}”</p>}
        {sources.length === 0 ? (
          <p className="hint">연결된 곳이 없습니다.</p>
        ) : (
          <ul className="backlink-list">
            {sources.map((s) => (
              <li key={`${s.path}:${s.nodeId}`}>
                <button onClick={() => go(s)}>
                  <span>{s.kind === 'map' ? '◉' : '📄'}</span>
                  <span className="bl-main">
                    <strong>{s.title}</strong>
                    {s.nodeText && <span className="bl-node">{s.nodeText}</span>}
                    <span className="bl-path">{s.path}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
