import { useEffect, useRef, useState } from 'react';
import { dirOf } from '@mindmap/core';
import { useAux } from '../workspace';
import { useStudy } from '../study';
import { imageFiles, insertImageRefs, uploadImage } from '../upload';
import { useStore } from '../store';
import type { Box } from '../layout';
import { MarkdownView } from './MarkdownView';

export const POSTIT_WIDTH = 270;

interface PostItProps {
  box: Box;
  mapPath: string;
  /** 가리기 모드에서 아직 드러나지 않음 */
  masked?: boolean;
  /** 가리기 모드 중에는 편집할 수 없다 */
  locked?: boolean;
}

export function PostIt({ box, mapPath, masked = false, locked = false }: PostItProps) {
  const node = box.node;
  const editing = useAux((s) => s.noteEditing === node.id);
  const note = node.note ?? '';
  const left = box.side === -1 ? box.x + box.w - POSTIT_WIDTH : box.x;

  return (
    <div
      className="postit"
      style={{ left, top: box.y + box.h + 6, width: POSTIT_WIDTH }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className="postit-head">
        <span className="postit-title">📌 메모</span>
        <span className="postit-tools">
          {!editing && !locked && (
            <button title="편집 (더블클릭)" onClick={() => useAux.getState().startNoteEdit(node.id)}>
              ✎
            </button>
          )}
          <button title="닫기 (F4)" onClick={() => useAux.getState().toggleNote(node.id)}>
            ✕
          </button>
        </span>
      </div>
      {masked ? (
        <button className="postit-mask" onClick={() => useStudy.getState().reveal(`m:${node.id}`)}>
          클릭해서 메모 보기
        </button>
      ) : editing ? (
        <NoteEditor id={node.id} initial={note} mapPath={mapPath} />
      ) : (
        <div className="postit-body" onDoubleClick={() => !locked && useAux.getState().startNoteEdit(node.id)}>
          {note.trim() ? (
            <MarkdownView md={note} baseDir={dirOf(mapPath)} fromPath={mapPath} />
          ) : (
            <p className="placeholder">비어 있음 — 더블클릭해서 편집</p>
          )}
        </div>
      )}
    </div>
  );
}

function NoteEditor({ id, initial, mapPath }: { id: string; initial: string; mapPath: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(initial);
  const done = useRef(false);

  useEffect(() => {
    const ta = ref.current!;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, []);

  const commit = () => {
    if (done.current) return;
    done.current = true;
    useAux.getState().commitNote(id, text);
  };

  const attach = async (files: File[]) => {
    const ta = ref.current;
    if (!ta || !files.length) return;
    try {
      const refs = await Promise.all(files.map((f) => uploadImage(f, mapPath)));
      setText(insertImageRefs(ta, refs));
    } catch (e) {
      useStore.getState().toast(`이미지 첨부 실패: ${(e as Error).message}`, 'error');
    }
  };

  return (
    <textarea
      ref={ref}
      className="postit-input"
      value={text}
      placeholder="메모 (Markdown, 이미지 붙여넣기 가능)"
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          done.current = true;
          useAux.getState().cancelNoteEdit(id);
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          commit();
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          commit();
          void useStore.getState().save();
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
  );
}
