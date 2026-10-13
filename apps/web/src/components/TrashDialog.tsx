import { useCallback, useEffect, useState } from 'react';
import type { TrashGroup } from '@mindmap/core';
import { api } from '../api';
import { useAux } from '../workspace';
import { useStore } from '../store';
import { refreshTrashCount, restoreGroup } from '../treeActions';

const KIND = { map: '맵', folder: '폴더', file: '파일' } as const;

function summary(g: TrashGroup) {
  return [g.maps && `맵 ${g.maps}`, g.pages && `페이지 ${g.pages}`, g.images && `이미지 ${g.images}`, g.others && `기타 ${g.others}`]
    .filter(Boolean)
    .join(' · ');
}

/** 휴지통: 복원, 영구 삭제, 비우기 */
export function TrashDialog() {
  const dialog = useAux((s) => s.dialog);
  const [list, setList] = useState<TrashGroup[] | null>(null);
  const [busy, setBusy] = useState(false);
  const open = dialog === 'trash';

  const load = useCallback(async () => {
    try {
      setList(await api.trashList());
    } catch (e) {
      useStore.getState().toast((e as Error).message, 'error');
      setList([]);
    }
    void refreshTrashCount();
  }, []);

  useEffect(() => {
    if (open) {
      setList(null);
      void load();
    }
  }, [open, load]);

  if (!open) return null;
  const close = () => useAux.getState().closeDialog();

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await useStore.getState().loadTree();
      await load();
    } catch (e) {
      useStore.getState().toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={close} onKeyDown={(e) => e.key === 'Escape' && close()}>
      <div className="modal trash" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="휴지통">
        <div className="modal-head">
          <h2>🗑 휴지통</h2>
          <button onClick={close} aria-label="닫기" autoFocus>
            ✕
          </button>
        </div>
        <p className="hint">삭제한 지 30일이 지나면 자동으로 영구 삭제됩니다. 다른 기기에서 지운 것도 여기에 나타납니다.</p>
        {list === null ? (
          <p className="hint">불러오는 중…</p>
        ) : list.length === 0 ? (
          <p className="hint">휴지통이 비어 있습니다.</p>
        ) : (
          <ul className="trash-list">
            {list.map((g) => (
              <li key={g.id}>
                <div className="trash-main">
                  <strong>
                    {KIND[g.kind]} · {g.path.replace(/\.mm\.md$/, '').split('/').pop() || g.path}
                  </strong>
                  <span className="trash-path">{g.path}</span>
                  <span className="trash-meta">
                    {new Date(g.deletedAt).toLocaleString()} · {summary(g)} · 남은 {g.daysLeft}일
                  </span>
                </div>
                <div className="trash-actions">
                  <button disabled={busy} onClick={() => {
                      close();
                      void restoreGroup(g.id, true);
                    }}>
                    복원
                  </button>
                  <button
                    className="danger"
                    disabled={busy}
                    onClick={() => confirm('영구 삭제하면 복구할 수 없습니다. 삭제할까요?') && void act(() => api.trashPurge({ id: g.id }))}
                  >
                    영구 삭제
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {!!list?.length && (
          <div className="modal-actions">
            <button
              className="danger"
              disabled={busy}
              onClick={() => confirm(`휴지통의 ${list.length}개 항목을 모두 영구 삭제할까요? 복구할 수 없습니다.`) && void act(() => api.trashPurge({ all: true }))}
            >
              휴지통 비우기
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
