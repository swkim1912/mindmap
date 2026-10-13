import { useRef, useState } from 'react';
import { useAux } from '../workspace';
import { useStore } from '../store';
import { getBackend } from '../api';
import { EXPORT_FORMATS, exportMap, parseImport, saveImported, type ExportFormat } from '../portable';

function parentDir(path: string) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** 내보내기·가져오기·버전 기록·백업을 한곳에서 */
export function PortableDialog() {
  const dialog = useAux((s) => s.dialog);
  const map = useStore((s) => s.map);
  const [busy, setBusy] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  if (dialog !== 'portable') return null;

  const close = () => useAux.getState().closeDialog();
  const toast = (m: string, kind: 'info' | 'error' = 'info') => useStore.getState().toast(m, kind);
  const canManage = getBackend().canManage;

  const doExport = async (f: ExportFormat) => {
    if (!map) return;
    setBusy(f);
    try {
      await exportMap(map.doc, f);
      if (f !== 'pdf') toast('내보냈습니다');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const doImport = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy('import');
    try {
      const dir = map ? parentDir(map.path) : '';
      let last = '';
      let count = 0;
      for (const file of [...files]) {
        for (const doc of await parseImport(file)) {
          last = await saveImported(dir, doc);
          count++;
        }
      }
      await useStore.getState().loadTree();
      close();
      if (last) await useStore.getState().openMap(last);
      toast(`맵 ${count}개를 가져왔습니다`);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={close} onKeyDown={(e) => e.key === 'Escape' && close()}>
      <div className="modal portable" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="내보내기와 가져오기">
        <div className="modal-head">
          <h2>내보내기 · 가져오기</h2>
          <button onClick={close} aria-label="닫기" autoFocus>
            ✕
          </button>
        </div>

        {map && (
          <section>
            <h3>이 맵 내보내기</h3>
            <ul className="portable-list">
              {EXPORT_FORMATS.map((f) => (
                <li key={f.id}>
                  <button disabled={busy !== null} onClick={() => void doExport(f.id)}>
                    <strong>{f.label}</strong>
                    <span>{busy === f.id ? '만드는 중…' : f.hint}</span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="hint">이미지·PDF 에는 메모(포스트잇)가 들어가지 않습니다. 원본(.mm.md)과 OPML·XMind 에는 메모가 들어갑니다.</p>
          </section>
        )}

        <section>
          <h3>가져오기</h3>
          <p className="hint">XMind(.xmind), OPML(.opml), Markdown 목록·제목(.md, .txt), 이 앱의 맵(.mm.md)을 새 맵으로 만듭니다.</p>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept=".xmind,.opml,.xml,.md,.markdown,.txt"
            onChange={(e) => void doImport(e.target.files)}
            disabled={busy !== null}
          />
        </section>

        {canManage && (
          <section>
            <h3>보관</h3>
            <div className="modal-actions">
              {map && <button onClick={() => useAux.getState().openDialog('history')}>이 맵의 이전 버전…</button>}
              <a className="button-link" href="/api/backup" download>
                Vault 전체 백업 (zip)
              </a>
            </div>
            <p className="hint">백업에는 맵·페이지·이미지·복습 기록이 들어갑니다. 복원하려면 zip 을 Vault 폴더에 풀어 넣으세요.</p>
          </section>
        )}
      </div>
    </div>
  );
}
