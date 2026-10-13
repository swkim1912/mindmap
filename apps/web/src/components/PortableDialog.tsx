import { useRef, useState } from 'react';
import { useAux } from '../workspace';
import { useStore } from '../store';
import { getBackend } from '../api';
import { EXPORT_FORMATS, download, exportMap, parseImportDetailed, parseImportText, saveImported, type ExportFormat } from '../portable';
import aiGuide from '../../../../docs/AI-GUIDE.md?raw';

function parentDir(path: string) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** 내보내기·가져오기·버전 기록·백업을 한곳에서 */
export function PortableDialog() {
  const dialog = useAux((s) => s.dialog);
  const map = useStore((s) => s.map);
  const [busy, setBusy] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
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

  /** 가져온 결과를 저장하고 마지막 맵을 연다. 맵 형식으로 읽다 해석하지 못한 줄이 있으면 알려 준다. */
  const finishImport = async (last: string, count: number, warnings: number) => {
    await useStore.getState().loadTree();
    close();
    if (last) await useStore.getState().openMap(last);
    toast(
      warnings
        ? `맵 ${count}개를 가져왔습니다 — 해석하지 못한 줄이 ${warnings}건 있습니다 (맵 위쪽 ⚠ 표시에서 확인)`
        : `맵 ${count}개를 가져왔습니다`,
      warnings ? 'error' : 'info',
    );
  };

  const doImport = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy('import');
    try {
      const dir = map ? parentDir(map.path) : '';
      let last = '';
      let count = 0;
      let warnings = 0;
      for (const file of [...files]) {
        for (const r of await parseImportDetailed(file)) {
          last = await saveImported(dir, r.doc);
          warnings += r.warnings;
          count++;
        }
      }
      await finishImport(last, count, warnings);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  /** AI 채팅에서 복사한 마크다운을 붙여넣어 가져온다 */
  const doPaste = async () => {
    setBusy('paste');
    try {
      const r = parseImportText(pasted);
      const path = await saveImported(map ? parentDir(map.path) : '', r.doc);
      setPasted('');
      await finishImport(path, 1, r.warnings);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const copyGuide = async () => {
    try {
      await navigator.clipboard.writeText(aiGuide);
      toast('AI 가이드를 복사했습니다. AI 채팅에 붙여넣고 요청하세요');
    } catch {
      download(aiGuide, '마인드맵-AI-가이드.md', 'text/markdown');
      toast('복사할 수 없어 파일로 받았습니다');
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
          <h3>AI로 맵 만들기</h3>
          <p className="hint">
            Claude 같은 AI 채팅에 <strong>AI 가이드</strong>를 붙여넣고 자료와 함께 요청하면, 이 앱 형식의 마크다운을 만들어 줍니다. 그 결과를 아래에
            붙여넣으면 새 맵이 됩니다. 태그·메모·카드(<code>질문 :: 답</code>, <code>==빈칸==</code>)도 그대로 살아납니다.
          </p>
          <div className="modal-actions">
            <button onClick={() => void copyGuide()}>AI 가이드 복사</button>
            <button onClick={() => download(aiGuide, '마인드맵-AI-가이드.md', 'text/markdown')}>가이드 파일 받기</button>
          </div>
          <textarea
            className="paste-area"
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder={'AI가 만들어 준 마크다운을 여기에 붙여넣으세요\n(코드블록 ```` 표시가 같이 복사되어도 괜찮습니다)'}
            rows={5}
            spellCheck={false}
          />
          <div className="modal-actions">
            <button disabled={busy !== null || !pasted.trim()} onClick={() => void doPaste()}>
              {busy === 'paste' ? '만드는 중…' : '붙여넣은 내용으로 새 맵 만들기'}
            </button>
          </div>
        </section>

        <section>
          <h3>파일로 가져오기</h3>
          <p className="hint">
            이 앱의 맵(.mm.md · .md — 내용을 보고 자동 판별), 일반 Markdown 제목·목록(.md, .txt), OPML(.opml), XMind(.xmind)를 새 맵으로 만듭니다. 같은 이름이
            있으면 “이름 (2)” 로 만듭니다.
          </p>
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
