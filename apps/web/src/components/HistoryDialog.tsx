import { useEffect, useState } from 'react';
import { api, type HistoryEntry } from '../api';
import { useAux } from '../workspace';
import { useStore } from '../store';

/** 이전 버전 목록을 보고 한 버전으로 되돌린다. 되돌리기 직전의 내용도 기록에 남는다. */
export function HistoryDialog() {
  const dialog = useAux((s) => s.dialog);
  const path = useStore((s) => s.map?.path);
  const [list, setList] = useState<HistoryEntry[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [preview, setPreview] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const open = dialog === 'history' && !!path;

  useEffect(() => {
    if (!open || !path) return;
    setList(null);
    setSel(null);
    setPreview('');
    void api
      .history(path)
      .then(setList)
      .catch((e) => useStore.getState().toast((e as Error).message, 'error'));
  }, [open, path]);

  useEffect(() => {
    if (!open || !path || !sel) return;
    let alive = true;
    void api
      .historyFile(path, sel)
      .then((r) => alive && setPreview(r.content))
      .catch(() => alive && setPreview('(불러오지 못했습니다)'));
    return () => {
      alive = false;
    };
  }, [open, path, sel]);

  if (!open || !path) return null;
  const close = () => useAux.getState().closeDialog();

  const restore = async () => {
    if (!sel) return;
    const when = new Date(list!.find((e) => e.name === sel)!.time).toLocaleString();
    if (!confirm(`${when} 버전으로 되돌릴까요?\n지금 내용은 이전 버전 목록에 남습니다.`)) return;
    setBusy(true);
    try {
      const st = useStore.getState();
      await st.save(); // 화면에서 고친 내용을 먼저 저장해야 기록에 남는다
      const baseHash = useStore.getState().map?.baseHash ?? null;
      await api.restore(path, sel, baseHash);
      await useStore.getState().recheckFile();
      st.toast('이전 버전으로 되돌렸습니다');
      close();
    } catch (e) {
      useStore.getState().toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={close} onKeyDown={(e) => e.key === 'Escape' && close()}>
      <div className="modal history" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="이전 버전">
        <div className="modal-head">
          <h2>이전 버전</h2>
          <button onClick={close} aria-label="닫기" autoFocus>
            ✕
          </button>
        </div>
        <p className="hint">{path} · 저장할 때 5분에 한 번 이전 내용이 기록되고 최근 50개를 보관합니다.</p>
        {list === null ? (
          <p className="hint">불러오는 중…</p>
        ) : list.length === 0 ? (
          <p className="hint">아직 기록된 이전 버전이 없습니다.</p>
        ) : (
          <div className="history-body">
            <ul className="history-list">
              {list.map((e) => (
                <li key={e.name}>
                  <button className={sel === e.name ? 'on' : ''} onClick={() => setSel(e.name)}>
                    {new Date(e.time).toLocaleString()}
                    <small>{(e.size / 1024).toFixed(1)}KB</small>
                  </button>
                </li>
              ))}
            </ul>
            <div className="history-preview">
              {sel ? <pre>{preview}</pre> : <p className="hint">왼쪽에서 버전을 고르면 내용을 볼 수 있습니다.</p>}
            </div>
          </div>
        )}
        <div className="modal-actions">
          <button disabled={!sel || busy} onClick={() => void restore()}>
            이 버전으로 되돌리기
          </button>
        </div>
      </div>
    </div>
  );
}
