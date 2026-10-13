import { useRef } from 'react';
import { dirOf, displayName, formatWikiLink, linkTargetFor } from '@mindmap/core';
import { useAux, type PageMode } from '../workspace';
import { stripFrontmatter } from '../markdown';
import { imageFiles, insertAtCaret, insertImageRefs, uploadImage } from '../upload';
import { useStore } from '../store';
import { MarkdownView } from './MarkdownView';

const MODES: [PageMode, string][] = [
  ['edit', '편집'],
  ['split', '분할'],
  ['preview', '미리보기'],
];

const SAVE_LABEL = { saved: '저장됨', dirty: '저장 대기', saving: '저장 중…', error: '저장 오류' } as const;

export function PageModal() {
  const page = useAux((s) => s.page);
  const mode = useAux((s) => s.pageMode);
  const canBack = useAux((s) => s.pageStack.length > 0);
  const dialogOpen = useAux((s) => s.dialog !== null);
  const ref = useRef<HTMLTextAreaElement>(null);
  if (!page) return null;

  const close = () => void useAux.getState().closePage();
  const setContent = (v: string) => useAux.getState().setPageContent(v);
  const path = page.path;

  const attach = async (files: File[]) => {
    const ta = ref.current;
    if (!ta || !files.length) return;
    try {
      const refs = await Promise.all(files.map((f) => uploadImage(f, path)));
      setContent(insertImageRefs(ta, refs));
    } catch (e) {
      useStore.getState().toast(`이미지 첨부 실패: ${(e as Error).message}`, 'error');
    }
  };

  const pickLink = () => {
    const ta = ref.current;
    const pos = ta ? [ta.selectionStart, ta.selectionEnd] : [page.content.length, page.content.length];
    useAux.getState().openLinkPicker((raw) => {
      const cur = useAux.getState().page;
      if (!cur) return;
      const c = cur.content;
      setContent(c.slice(0, pos[0]) + raw + c.slice(pos[1]));
      setTimeout(() => ref.current?.focus(), 0);
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (dialogOpen) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.nativeEvent.isComposing) return;
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void useAux.getState().savePage();
    } else if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      pickLink();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };

  const title = /^---\r?\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m.exec(page.content)?.[1] ?? displayName(path);
  const folder = dirOf(path);

  return (
    <div className="modal-backdrop page-backdrop" onMouseDown={close}>
      <div className="page-modal" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown} role="dialog" aria-label={title}>
        <div className="page-head">
          {canBack && (
            <button onClick={() => void useAux.getState().pageBack()} title="이전 페이지">
              ←
            </button>
          )}
          <div className="page-title" title={path}>
            <strong>{title}</strong>
            <span className="page-folder">{folder}</span>
          </div>
          <div className="segmented tb-group">
            {MODES.map(([m, label]) => (
              <button key={m} className={mode === m ? 'on' : ''} onClick={() => useAux.getState().setPageMode(m)}>
                {label}
              </button>
            ))}
          </div>
          <button onClick={pickLink} title="링크 삽입 (Ctrl+K)">🔗</button>
          <span className={`save-state ${page.saveState}`}>{SAVE_LABEL[page.saveState]}</span>
          <button onClick={close} title="닫기 (Esc)" aria-label="닫기">
            ✕
          </button>
        </div>

        {page.conflict && (
          <div className="conflict-bar">
            디스크의 파일이 외부에서 변경되었습니다.
            <button onClick={() => useAux.getState().resolveConflict('mine')}>내 내용으로 덮어쓰기</button>
            <button onClick={() => useAux.getState().resolveConflict('disk')}>디스크 내용 불러오기</button>
          </div>
        )}

        <div className={`page-body mode-${mode}`}>
          {mode !== 'preview' && (
            <textarea
              ref={ref}
              className="page-editor"
              value={page.content}
              spellCheck={false}
              autoFocus
              placeholder="Markdown으로 작성하세요. 이미지는 붙여넣기/드롭, 링크는 [[ ]] 또는 Ctrl+K"
              onChange={(e) => setContent(e.target.value)}
              onBlur={() => void useAux.getState().savePage()}
              onKeyDown={(e) => {
                if (e.key === 'Tab' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  setContent(insertAtCaret(e.currentTarget, '  '));
                }
              }}
              onPaste={(e) => {
                const files = imageFiles(e.clipboardData);
                if (!files.length) return;
                e.preventDefault();
                void attach(files);
              }}
              onDrop={(e) => {
                const files = imageFiles(e.dataTransfer);
                if (!files.length) return;
                e.preventDefault();
                void attach(files);
              }}
            />
          )}
          {mode !== 'edit' && (
            <div className="page-preview">
              <MarkdownView md={stripFrontmatter(page.content)} baseDir={dirOf(path)} fromPath={path} />
            </div>
          )}
        </div>

        <div className="page-foot">
          <span className="foot-label">이 페이지를 가리키는 곳 {page.backlinks.length}</span>
          {page.backlinks.map((b) => (
            <button
              key={`${b.path}:${b.nodeId}`}
              className="chip"
              title={b.path}
              onClick={() =>
                b.kind === 'map'
                  ? void useAux.getState().goMap(b.path, b.nodeId)
                  : void useAux.getState().openPage(b.path, { push: true })
              }
            >
              {b.kind === 'map' ? '◉' : '📄'} {b.nodeText ? `${b.title} › ${b.nodeText}` : b.title}
            </button>
          ))}
          <button
            className="chip ghost"
            title="이 페이지를 가리키는 링크 복사"
            onClick={() => {
              void navigator.clipboard?.writeText(formatWikiLink({ target: linkTargetFor(path) }));
              useStore.getState().toast('링크를 복사했습니다');
            }}
          >
            링크 복사
          </button>
        </div>
      </div>
    </div>
  );
}
