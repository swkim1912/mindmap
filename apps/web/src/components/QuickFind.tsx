import { useEffect, useRef, useState } from 'react';
import { displayName, formatWikiLink, linkTargetFor } from '@mindmap/core';
import { api } from '../api';
import { titleFromNodeText, useAux } from '../workspace';
import { useStore } from '../store';
import type { SearchHit } from '../types';

const ICON = { map: '◉', page: '📄', node: '•' } as const;

/** 링크 문자열로 만들 때 쓰는 노드 표시명 */
function labelFor(hit: SearchHit): string {
  return titleFromNodeText(hit.title) || displayName(hit.path);
}

export function rawLinkFor(hit: SearchHit): string {
  const target = linkTargetFor(hit.path);
  if (hit.kind === 'node') return formatWikiLink({ target, nodeId: hit.nodeId, label: labelFor(hit) });
  return formatWikiLink({ target, label: hit.title });
}

/** Ctrl+P 전체 검색 / Ctrl+K 링크 삽입이 같이 쓰는 검색 창 */
export function QuickFind() {
  const dialog = useAux((s) => s.dialog);
  const picker = useAux((s) => s.linkPicker);
  const open = dialog === 'search' || dialog === 'link';
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const isLink = dialog === 'link';

  useEffect(() => {
    if (!open) return;
    setQ('');
    setSel(0);
    const t = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open, dialog]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const r = await api.search(q);
        if (!cancelled) {
          setHits(r);
          setSel(0);
        }
      } catch {
        if (!cancelled) setHits([]);
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, open]);

  useEffect(() => {
    list.current?.querySelector('.qf-row.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel, hits]);

  if (!open) return null;

  const close = () => useAux.getState().closeDialog();
  const createRow = isLink && q.trim() !== '';
  const rowCount = hits.length + (createRow ? 1 : 0);

  const choose = async (index: number) => {
    const aux = useAux.getState();
    if (createRow && index === hits.length) {
      try {
        const path = await aux.makePage(q);
        picker?.(formatWikiLink({ target: linkTargetFor(path), label: titleFromNodeText(q) }));
        close();
      } catch (e) {
        useStore.getState().toast(`페이지를 만들 수 없습니다: ${(e as Error).message}`, 'error');
      }
      return;
    }
    const hit = hits[index];
    if (!hit) return;
    if (isLink) {
      picker?.(rawLinkFor(hit));
      close();
      return;
    }
    close();
    if (hit.kind === 'page') await aux.openPage(hit.path);
    else await aux.goMap(hit.path, hit.nodeId);
  };

  return (
    <div className="modal-backdrop top" onMouseDown={close}>
      <div className="quickfind" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={isLink ? '링크 삽입' : '검색'}>
        <input
          ref={input}
          autoFocus
          value={q}
          placeholder={isLink ? '연결할 맵 · 노드 · 페이지 검색 (없으면 새 페이지 만들기)' : '맵 · 노드 · 메모 · 페이지 검색   (#태그 로 태그 검색)'}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Escape') {
              e.preventDefault();
              close();
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel((s) => Math.min(rowCount - 1, s + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel((s) => Math.max(0, s - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              void choose(sel);
            }
          }}
        />
        <div className="qf-list" ref={list}>
          {hits.map((h, i) => (
            <div
              key={`${h.path}:${h.nodeId}:${i}`}
              className={`qf-row ${i === sel ? 'sel' : ''}`}
              onMouseMove={() => setSel(i)}
              onClick={() => void choose(i)}
            >
              <span className={`qf-icon ${h.kind}`}>{ICON[h.kind]}</span>
              <span className="qf-main">
                <span className="qf-title">{h.title}</span>
                <span className="qf-ctx">{h.context}</span>
                {h.snippet && <span className="qf-snip">{h.snippet}</span>}
              </span>
            </div>
          ))}
          {createRow && (
            <div
              className={`qf-row create ${hits.length === sel ? 'sel' : ''}`}
              onMouseMove={() => setSel(hits.length)}
              onClick={() => void choose(hits.length)}
            >
              <span className="qf-icon">＋</span>
              <span className="qf-main">
                <span className="qf-title">새 페이지 만들기: {q.trim()}</span>
                <span className="qf-ctx">현재 맵의 pages 폴더에 생성하고 링크를 넣습니다</span>
              </span>
            </div>
          )}
          {!busy && rowCount === 0 && <p className="qf-empty">결과가 없습니다</p>}
        </div>
        <div className="qf-foot">↑↓ 이동 · Enter {isLink ? '링크 삽입' : '열기'} · Esc 닫기</div>
      </div>
    </div>
  );
}
