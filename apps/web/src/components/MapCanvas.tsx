import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  findParent,
  getLayout,
  getTags,
  isAncestor,
  isCollapsed,
  moveNode,
  setText,
  toggleCollapsed,
  type LayoutKind,
  type MapNode,
} from '@mindmap/core';
import { useStore } from '../store';
import { commands } from '../commands';
import { flushEdit, registerCommitter } from '../editing';
import { computeLayout, edgePath, estimateSize, navigate, type Box, type Layout, type Size } from '../layout';
import { NodeText } from './NodeText';
import { branchColor, resolveColor } from '../colors';
import { canvasControls } from '../controls';

interface View {
  x: number;
  y: number;
  z: number;
}

type DropZone = 'before' | 'after' | 'child';
interface Drag {
  id: string;
  cx: number;
  cy: number;
  target: { id: string; zone: DropZone } | null;
}

export function MapCanvas() {
  const map = useStore((s) => s.map)!;
  const doc = map.doc;
  const kind = getLayout(doc);
  const primary = useStore((s) => s.primary);
  const selected = useStore((s) => s.selected);
  const editingId = useStore((s) => s.editing?.id ?? null);
  const revealSeq = useStore((s) => s.revealSeq);

  const viewportRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState<Map<string, Size>>(() => new Map());
  const [view, setView] = useState<View>({ x: 0, y: 0, z: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [drag, setDrag] = useState<Drag | null>(null);
  const needFit = useRef(true);
  const lastKind = useRef(kind);
  if (lastKind.current !== kind) {
    lastKind.current = kind;
    needFit.current = true;
  }
  const [fontsTick, setFontsTick] = useState(0);

  const layout = useMemo(
    () => computeLayout(doc.root, kind, (n, d) => sizes.get(n.id) ?? estimateSize(n, d)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc.root, kind, sizes, fontsTick],
  );
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // 렌더 후 실제 노드 크기를 재서 레이아웃에 반영 (페인트 전에 처리되므로 깜빡임 없음)
  useLayoutEffect(() => {
    const world = worldRef.current;
    if (!world) return;
    let changed = false;
    const next = new Map(sizes);
    world.querySelectorAll<HTMLElement>('[data-node-id]').forEach((el) => {
      const id = el.dataset.nodeId!;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const prev = sizes.get(id);
      if (!prev || Math.abs(prev.w - w) > 0.5 || Math.abs(prev.h - h) > 0.5) {
        next.set(id, { w, h });
        changed = true;
      }
    });
    if (changed) setSizes(next);
    else if (needFit.current) {
      needFit.current = false;
      fit();
    }
  });

  useEffect(() => {
    const onDone = () => setFontsTick((t) => t + 1);
    document.fonts?.addEventListener('loadingdone', onDone);
    return () => document.fonts?.removeEventListener('loadingdone', onDone);
  }, []);

  const fit = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    // 아직 화면 크기가 잡히지 않았으면 크기가 생길 때(ResizeObserver) 다시 시도
    if (vp.clientWidth < 50 || vp.clientHeight < 50) {
      needFit.current = true;
      return;
    }
    const { bounds } = layoutRef.current;
    const bw = bounds.maxX - bounds.minX;
    const bh = bounds.maxY - bounds.minY;
    const z = Math.max(0.3, Math.min(1.2, (vp.clientWidth - 80) / bw, (vp.clientHeight - 80) / bh));
    setView({
      z,
      x: vp.clientWidth / 2 - (bounds.minX + bw / 2) * z,
      y: vp.clientHeight / 2 - (bounds.minY + bh / 2) * z,
    });
  }, []);

  const zoomAt = useCallback((factor: number, px?: number, py?: number) => {
    const vp = viewportRef.current;
    if (!vp) return;
    setView((v) => {
      const z = Math.max(0.2, Math.min(3, v.z * factor));
      const cx = px ?? vp.clientWidth / 2;
      const cy = py ?? vp.clientHeight / 2;
      return { z, x: cx - ((cx - v.x) * z) / v.z, y: cy - ((cy - v.y) * z) / v.z };
    });
  }, []);

  useEffect(() => {
    const vp = viewportRef.current!;
    const ro = new ResizeObserver(() => {
      if (needFit.current) {
        needFit.current = false;
        fit();
      }
    });
    ro.observe(vp);
    return () => ro.disconnect();
  }, [fit]);

  canvasControls.fit = fit;
  canvasControls.zoomBy = (f) => zoomAt(f);

  // 선택된 노드가 화면 밖이면 보이도록 이동
  useEffect(() => {
    const vp = viewportRef.current;
    const b = primary ? layoutRef.current.boxes.get(primary) : null;
    if (!vp || !b || needFit.current) return;
    setView((v) => {
      const m = 60;
      const sx = b.x * v.z + v.x;
      const sy = b.y * v.z + v.y;
      const sw = b.w * v.z;
      const sh = b.h * v.z;
      let dx = 0;
      let dy = 0;
      if (sx < m) dx = m - sx;
      else if (sx + sw > vp.clientWidth - m) dx = vp.clientWidth - m - (sx + sw);
      if (sy < m) dy = m - sy;
      else if (sy + sh > vp.clientHeight - m) dy = vp.clientHeight - m - (sy + sh);
      return dx || dy ? { ...v, x: v.x + dx, y: v.y + dy } : v;
    });
  }, [revealSeq, primary, layout]);

  // 휠: 이동, Ctrl+휠: 확대/축소
  useEffect(() => {
    const vp = viewportRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = vp.getBoundingClientRect();
        zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
      } else {
        setView((v) => ({ ...v, x: v.x - (e.shiftKey ? e.deltaY : e.deltaX), y: v.y - (e.shiftKey ? 0 : e.deltaY) }));
      }
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  // 배경 드래그로 화면 이동
  const onBackgroundPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    flushEdit();
    focusSink();
    const start = { x: e.clientX, y: e.clientY, v: viewRef.current };
    const move = (ev: PointerEvent) =>
      setView({ ...start.v, x: start.v.x + ev.clientX - start.x, y: start.v.y + ev.clientY - start.y });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const toWorld = (clientX: number, clientY: number) => {
    const r = viewportRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (clientX - r.left - v.x) / v.z, y: (clientY - r.top - v.y) / v.z };
  };

  // 노드 드래그 앤 드롭
  const onNodePointerDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const st = useStore.getState();
    if (st.editing?.id === id) return; // 편집 중에는 텍스트 선택을 허용
    e.preventDefault();
    st.select(id, e.shiftKey || e.ctrlKey || e.metaKey ? 'toggle' : 'replace');
    focusSink();
    const root = st.map!.doc.root;
    if (id === root.id) return;
    const sx = e.clientX;
    const sy = e.clientY;
    let current: Drag | null = null;
    const move = (ev: PointerEvent) => {
      if (!current && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      const w = toWorld(ev.clientX, ev.clientY);
      let target: Drag['target'] = null;
      for (const b of layoutRef.current.order) {
        if (w.x < b.x || w.x > b.x + b.w || w.y < b.y || w.y > b.y + b.h) continue;
        if (b.id === id || isAncestor(root, id, b.id)) break;
        const rel = (w.y - b.y) / b.h;
        const zone: DropZone = b.depth === 0 ? 'child' : rel < 0.3 ? 'before' : rel > 0.7 ? 'after' : 'child';
        target = { id: b.id, zone };
        break;
      }
      current = { id, cx: w.x, cy: w.y, target };
      setDrag(current);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      const t = current?.target;
      if (!t) return;
      useStore.getState().apply((d) => {
        if (t.zone === 'child') {
          moveNode(d, id, t.id, Number.MAX_SAFE_INTEGER);
        } else {
          const loc = findParent(d.root, t.id);
          if (loc) moveNode(d, id, loc.parent.id, loc.index + (t.zone === 'after' ? 1 : 0));
        }
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // 키보드 단축키 (편집 중이 아닐 때)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => handleKey(e, layoutRef.current, zoomAt, fit);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomAt, fit]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const childCount = useMemo(() => {
    const m = new Map<string, number>();
    const count = (n: MapNode): number => {
      const c = n.children.reduce((a, k) => a + 1 + count(k), 0);
      m.set(n.id, c);
      return c;
    };
    count(doc.root);
    return m;
  }, [doc.root]);

  return (
    <div ref={viewportRef} className="viewport" onPointerDown={onBackgroundPointerDown}>
      <div
        ref={worldRef}
        className="world"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}
      >
        <Edges layout={layout} kind={kind} />
        {layout.order.map((b) => (
          <NodeView
            key={b.id}
            box={b}
            kind={kind}
            selected={selectedSet.has(b.id)}
            isPrimary={primary === b.id}
            isEditing={editingId === b.id}
            descendants={childCount.get(b.id) ?? 0}
            drop={drag?.target?.id === b.id ? drag.target.zone : null}
            onPointerDown={onNodePointerDown}
          />
        ))}
        {drag && (
          <div className="drag-ghost" style={{ left: drag.cx + 8, top: drag.cy + 8 }}>
            <NodeText text={layout.boxes.get(drag.id)?.node.text ?? ''} />
          </div>
        )}
      </div>
      <div className="zoom-indicator">{Math.round(view.z * 100)}%</div>
    </div>
  );
}

function focusSink() {
  requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea[data-sink]')?.focus({ preventScroll: true }));
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.dataset.sink !== undefined) return false;
  return t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
}

function handleKey(e: KeyboardEvent, layout: Layout, zoomAt: (f: number) => void, fit: () => void) {
  if (e.isComposing || e.keyCode === 229) return;
  const st = useStore.getState();
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key;

  // 어디서든 동작
  if (mod && key.toLowerCase() === 's') {
    e.preventDefault();
    flushEdit();
    void st.save();
    return;
  }
  if (key === 'F1' || (mod && (key === '?' || (e.shiftKey && key === '/')))) {
    e.preventDefault();
    st.setHelp(!st.helpOpen);
    return;
  }
  if (st.helpOpen) {
    if (key === 'Escape') st.setHelp(false);
    return;
  }
  if (st.editing || isTypingTarget(e.target) || !st.map) return;

  const p = st.primary;
  const handled = () => e.preventDefault();

  if (mod) {
    const k = key.toLowerCase();
    if (k === 'z' && !e.shiftKey) return handled(), st.undo();
    if (k === 'y' || (k === 'z' && e.shiftKey)) return handled(), st.redo();
    if (k === '/') return handled(), commands.toggleCollapse();
    if (k === '0') return handled(), fit();
    if (k === '=' || k === '+') return handled(), zoomAt(1.2);
    if (k === '-') return handled(), zoomAt(1 / 1.2);
    if (key === 'Enter') return handled(), commands.insertParent();
    return;
  }

  if (e.altKey) {
    if (key === 'ArrowUp') return handled(), commands.move(-1);
    if (key === 'ArrowDown') return handled(), commands.move(1);
    return;
  }

  switch (key) {
    case 'Tab':
      return handled(), commands.addChild();
    case 'Enter':
      if (performance.now() - lastImeCommit < 80) return handled();
      return handled(), commands.addSibling(e.shiftKey);
    case 'F2':
    case ' ':
      return handled(), commands.edit();
    case 'Delete':
    case 'Backspace':
      return handled(), commands.remove();
    case 'Escape':
      if (p) st.select(p);
      return handled();
    case 'Home':
      return handled(), st.select(st.map.doc.root.id);
    case 'ArrowUp':
    case 'ArrowDown':
    case 'ArrowLeft':
    case 'ArrowRight': {
      handled();
      if (!p) return;
      const dir = key.slice(5).toLowerCase() as 'up' | 'down' | 'left' | 'right';
      const next = navigate(layout, p, dir);
      if (next) st.select(next);
      else if ((dir === 'left' || dir === 'right') && isCollapsed(layout.boxes.get(p)!.node)) commands.toggleCollapse();
      return;
    }
  }
}

/** 한글 조합 중 Enter로 편집을 끝낸 직후 들어오는 두 번째 Enter를 무시하기 위한 시각 */
let lastImeCommit = 0;

function Edges({ layout, kind }: { layout: Layout; kind: LayoutKind }) {
  const { bounds } = layout;
  const pad = 20;
  return (
    <svg
      className="edges"
      style={{ left: bounds.minX - pad, top: bounds.minY - pad }}
      width={bounds.maxX - bounds.minX + pad * 2}
      height={bounds.maxY - bounds.minY + pad * 2}
      viewBox={`${bounds.minX - pad} ${bounds.minY - pad} ${bounds.maxX - bounds.minX + pad * 2} ${bounds.maxY - bounds.minY + pad * 2}`}
    >
      {layout.order.map((b) => {
        if (!b.parentId) return null;
        const p = layout.boxes.get(b.parentId)!;
        return (
          <path
            key={b.id}
            d={edgePath(p, b, kind)}
            stroke={branchColor(b.branch)}
            strokeWidth={b.depth === 1 ? 2.5 : 1.6}
            fill="none"
          />
        );
      })}
    </svg>
  );
}

interface NodeViewProps {
  box: Box;
  kind: LayoutKind;
  selected: boolean;
  isPrimary: boolean;
  isEditing: boolean;
  descendants: number;
  drop: DropZone | null;
  onPointerDown: (e: React.PointerEvent, id: string) => void;
}

const NodeView = memo(function NodeView({ box, kind, selected, isPrimary, isEditing, descendants, drop, onPointerDown }: NodeViewProps) {
  const n = box.node;
  const tags = getTags(n);
  const collapsed = isCollapsed(n);
  const custom = resolveColor(n.attrs.color);
  const accent = custom ?? branchColor(box.branch);
  const cls = [
    'node',
    `depth-${Math.min(box.depth, 2)}`,
    selected && 'selected',
    isPrimary && 'primary',
    isEditing && 'editing',
    custom && 'custom-color',
    drop && `drop-${drop}`,
  ]
    .filter(Boolean)
    .join(' ');
  const foldSide = box.side === -1 ? 'left' : 'right';
  const showFold = n.children.length > 0 && !(box.depth === 0 && kind === 'mindmap');

  return (
    <div
      className={cls}
      data-node-id={n.id}
      style={{ left: box.x, top: box.y, ['--accent' as string]: accent }}
      onPointerDown={(e) => onPointerDown(e, n.id)}
      onDoubleClick={(e) => {
        e.stopPropagation();
        useStore.getState().startEdit(n.id);
      }}
    >
      {isPrimary && <NodeEditor node={n} editing={isEditing} />}
      {!isEditing && (
        <div className="node-text">
          <NodeText text={n.text} />
        </div>
      )}
      {(tags.length > 0 || n.note !== null) && !isEditing && (
        <div className="node-meta">
          {n.note !== null && (
            <span className="note-badge" title={n.note}>
              📌
            </span>
          )}
          {tags.map((t) => (
            <span key={t} className="tag">
              {t}
            </span>
          ))}
        </div>
      )}
      {showFold && (
        <button
          className={`fold fold-${foldSide} ${collapsed ? 'is-collapsed' : ''}`}
          title={collapsed ? '펼치기 (Ctrl+/)' : '접기 (Ctrl+/)'}
          onPointerDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
          }}
          onClick={(e) => {
            e.stopPropagation();
            useStore.getState().apply((d) => toggleCollapsed(d, n.id));
          }}
        >
          {collapsed ? descendants : '−'}
        </button>
      )}
    </div>
  );
});

/**
 * 선택된 노드 안에 항상 존재하는 textarea.
 * 편집 중이 아닐 때는 보이지 않는 키 입력 수신기 역할을 해서, 바로 타이핑(한글 조합 포함)하면 편집이 시작된다.
 */
function NodeEditor({ node, editing }: { node: MapNode; editing: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState('');
  const draftRef = useRef('');
  const startedByTyping = useRef(false);
  const imeEnterPending = useRef(false);
  const wasEditing = useRef(false);

  const update = (v: string) => {
    draftRef.current = v;
    setDraft(v);
  };

  const commit = useCallback(() => {
    const st = useStore.getState();
    const ed = st.editing;
    if (!ed || ed.id !== node.id) return;
    const text = draftRef.current;
    if (ed.isNew && !text.trim()) {
      st.cancelNewNode();
    } else {
      st.apply((d) => setText(d, node.id, text), { mergeUndo: ed.isNew });
      st.stopEdit();
    }
    update('');
  }, [node.id]);

  const cancel = () => {
    const st = useStore.getState();
    if (st.editing?.isNew) st.cancelNewNode();
    else st.stopEdit();
    update('');
  };

  useEffect(() => {
    if (!editing) return;
    registerCommitter(commit);
    return () => registerCommitter(null);
  }, [editing, commit]);

  useLayoutEffect(() => {
    if (editing && !wasEditing.current) {
      if (!startedByTyping.current) {
        update(node.text);
        requestAnimationFrame(() => ref.current?.select());
      }
      startedByTyping.current = false;
    }
    if (!editing && wasEditing.current) update('');
    wasEditing.current = editing;
  }, [editing, node.text]);

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, [node.id, editing]);

  const beginByTyping = () => {
    if (editing) return;
    startedByTyping.current = true;
    useStore.getState().startEdit(node.id);
  };

  return (
    <textarea
      ref={ref}
      data-sink=""
      className={editing ? 'node-input' : 'node-sink'}
      value={draft}
      rows={1}
      spellCheck={false}
      aria-label="주제 편집"
      onChange={(e) => {
        if (!editing) beginByTyping();
        update(e.target.value);
      }}
      onCompositionStart={beginByTyping}
      onCompositionEnd={() => {
        if (imeEnterPending.current) {
          imeEnterPending.current = false;
          setTimeout(() => {
            lastImeCommit = performance.now();
            commit();
          }, 0);
        }
      }}
      onKeyDown={(e) => {
        if (!editing) return;
        e.stopPropagation();
        const composing = e.nativeEvent.isComposing || e.keyCode === 229;
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          if (composing) imeEnterPending.current = true;
          else commit();
          return;
        }
        if (composing) return;
        if (e.key === 'Tab') {
          e.preventDefault();
          const isNewEmpty = useStore.getState().editing?.isNew && !draftRef.current.trim();
          if (isNewEmpty) return;
          commit();
          commands.addChild();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancel();
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          commit();
          void useStore.getState().save();
        }
      }}
      onBlur={() => {
        if (editing) commit();
      }}
      onCopy={(e) => {
        if (editing) return;
        const t = commands.copyText();
        if (t === null) return;
        e.preventDefault();
        e.clipboardData.setData('text/plain', t);
      }}
      onCut={(e) => {
        if (editing) return;
        const t = commands.copyText();
        if (t === null) return;
        e.preventDefault();
        e.clipboardData.setData('text/plain', t);
        commands.remove();
      }}
      onPaste={(e) => {
        if (editing) return;
        e.preventDefault();
        commands.paste(e.clipboardData.getData('text/plain'));
      }}
    />
  );
}
