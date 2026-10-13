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
import { useAux } from '../workspace';
import { isEditLocked, isOverlayOpen } from '../overlay';
import { useStudy } from '../study';
import { PostIt } from './PostIt';
import { commands } from '../commands';
import { flushEdit, registerCommitter } from '../editing';
import { computeLayout, edgePath, estimateSize, navigate, type Box, type Layout, type Size } from '../layout';
import { NodeText } from './NodeText';
import { branchColor, resolveColor } from '../colors';
import { canvasControls, focusSink } from '../controls';

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

  const revealIds = useAux((s) => s.revealIds);
  const openNotes = useAux((s) => s.openNotes);
  const backlinks = useAux((s) => s.backlinks);
  const hide = useStudy((s) => s.hide);
  const revealSet = useMemo(() => {
    if (!hide) return new Set(revealIds);
    // 가리기 모드: 접힌 가지도 화면에서는 펼쳐서 연습할 구조를 모두 보여 준다
    const all = new Set<string>();
    const walk = (n: MapNode) => {
      if (n.children.length) all.add(n.id);
      n.children.forEach(walk);
    };
    walk(doc.root);
    return all;
  }, [revealIds, hide !== null, doc.root]); // eslint-disable-line react-hooks/exhaustive-deps

  const layout = useMemo(
    () => computeLayout(doc.root, kind, (n, d) => sizes.get(n.id) ?? estimateSize(n, d), revealSet),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc.root, kind, sizes, fontsTick, revealSet],
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
      // 포스트잇 안에서는 내용 스크롤을 우선한다
      if (!(e.ctrlKey || e.metaKey) && (e.target as HTMLElement).closest?.('.postit-body, .postit-input')) return;
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

  // 두 손가락 확대/축소 (터치). 노드 위에서 시작해도 동작하도록 캡처 단계에서 받는다.
  const pinching = useRef(false);
  useEffect(() => {
    const vp = viewportRef.current!;
    const pts = new Map<number, { x: number; y: number }>();
    let start: { d: number; z: number; cx: number; cy: number; x: number; y: number } | null = null;
    const pair = () => {
      const [a, b] = [...pts.values()];
      return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        const r = vp.getBoundingClientRect();
        const v = viewRef.current;
        const p = pair();
        start = { d: p.d, z: v.z, cx: p.mx - r.left, cy: p.my - r.top, x: v.x, y: v.y };
        pinching.current = true;
      }
    };
    const move = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size !== 2 || !start) return;
      const r = vp.getBoundingClientRect();
      const p = pair();
      const z = Math.max(0.2, Math.min(3, (start.z * p.d) / start.d));
      // 처음 두 손가락 가운데에 있던 지점이 지금 가운데 아래에 오도록 맞춘다
      const wx = (start.cx - start.x) / start.z;
      const wy = (start.cy - start.y) / start.z;
      setView({ z, x: p.mx - r.left - wx * z, y: p.my - r.top - wy * z });
    };
    const up = (e: PointerEvent) => {
      if (!pts.delete(e.pointerId)) return;
      if (pts.size < 2) {
        start = null;
        // 손가락을 떼는 순간의 이동이 끌기로 이어지지 않도록 잠깐 막는다
        setTimeout(() => {
          if (pts.size < 2) pinching.current = false;
        }, 120);
      }
    };
    vp.addEventListener('pointerdown', down, true);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      vp.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, []);

  // 배경 드래그로 화면 이동
  const startPan = (e: React.PointerEvent) => {
    const start = { x: e.clientX, y: e.clientY, v: viewRef.current };
    const move = (ev: PointerEvent) => {
      if (pinching.current) return;
      setView({ ...start.v, x: start.v.x + ev.clientX - start.x, y: start.v.y + ev.clientY - start.y });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const onBackgroundPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    flushEdit();
    focusSink();
    startPan(e);
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
    const study = useStudy.getState();
    if (study.hide) {
      // 가리기 모드: 탭/클릭하면 가렸다 열었다 한다. 손가락으로 끌면 화면 이동으로 본다.
      if (!study.hide.scope.has(id) || id === study.hide.scopeId) return;
      const sx = e.clientX;
      const sy = e.clientY;
      let moved = false;
      const onMove = (ev: PointerEvent) => {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 8) moved = true;
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        if (!moved && !pinching.current) useStudy.getState().toggle(`n:${id}`);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      if (e.pointerType === 'touch') startPan(e);
      return;
    }
    // 터치에서는 노드 위에서 끌어도 화면이 움직인다 (노드 옮기기는 마우스로)
    if (e.pointerType === 'touch') return startPan(e);
    const root = st.map!.doc.root;
    if (id === root.id) return;
    const sx = e.clientX;
    const sy = e.clientY;
    let current: Drag | null = null;
    const move = (ev: PointerEvent) => {
      if (pinching.current) return;
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
            noteOpen={openNotes.includes(b.id)}
            revealed={revealSet.has(b.id)}
            masked={!!hide && hide.scope.has(b.id) && b.id !== hide.scopeId && !hide.revealed.has(`n:${b.id}`)}
            clozeRevealed={hide && hide.scope.has(b.id) ? hide.revealed : null}
            hideActive={!!hide}
            backlinkCount={backlinks?.nodes[b.id]?.length ?? 0}
            drop={drag?.target?.id === b.id ? drag.target.zone : null}
            onPointerDown={onNodePointerDown}
          />
        ))}
        {openNotes.map((id) => {
          const b = layout.boxes.get(id);
          return b && b.node.note !== null ? (
            <PostIt
              key={id}
              box={b}
              mapPath={map.path}
              masked={!!hide && hide.scope.has(id) && !hide.revealed.has(`m:${id}`)}
              maskable={!!hide && hide.scope.has(id)}
              locked={!!hide}
            />
          ) : null;
        })}
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
  const aux = useAux.getState();
  // 대화상자·팝업 페이지·카드 복습 화면이 열려 있으면 맵 단축키는 쓰지 않는다
  if (isOverlayOpen()) return;
  if (st.editing || isTypingTarget(e.target) || !st.map) return;

  const p = st.primary;
  const handled = () => e.preventDefault();

  const study = useStudy.getState();
  if (study.hide) {
    // 가리기 모드: Space/Enter 로 하나씩 드러내고, 편집 키는 모두 막는다
    if (key === 'F8' || key === 'Escape') return handled(), study.exitHide();
    if (key === ' ' || key === 'Enter') return handled(), e.shiftKey ? study.revealAll() : study.revealNext(p);
    const allowed = (key.startsWith('Arrow') && !e.altKey && !mod) || key === 'Home' || key === 'F1' ||
      (mod && ['0', '=', '+', '-', 'p'].includes(key.toLowerCase()));
    if (!allowed) {
      if (['Tab', 'Backspace', 'Delete', 'F2', 'F4'].includes(key)) handled();
      return;
    }
  }

  if (mod) {
    const k = key.toLowerCase();
    if (k === 'z' && !e.shiftKey) return handled(), st.undo();
    if (k === 'y' || (k === 'z' && e.shiftKey)) return handled(), st.redo();
    if (k === '/') return handled(), commands.toggleCollapse();
    if (k === '0') return handled(), fit();
    if (k === '=' || k === '+') return handled(), zoomAt(1.2);
    if (k === '-') return handled(), zoomAt(1 / 1.2);
    if (key === 'Enter') return handled(), commands.insertParent();
    if (k === 'p') return handled(), aux.openSearch();
    if (k === 'k') return handled(), p && aux.openLinkPicker((raw) => aux.appendLinkToNode(p, raw));
    if (k === 'e') return handled(), p && void aux.openOrCreatePage(p);
    return;
  }

  if (e.altKey) {
    if (key === 'ArrowUp') return handled(), commands.move(-1);
    if (key === 'ArrowDown') return handled(), commands.move(1);
    if (key === 'ArrowLeft') return handled(), void aux.back();
    return;
  }

  switch (key) {
    case 'Tab':
      return handled(), commands.addChild();
    case 'Enter':
      if (performance.now() - lastImeCommit < 80) return handled();
      return handled(), commands.addSibling(e.shiftKey);
    case 'F8':
      return handled(), study.enterHide(p);
    case 'F4':
      handled();
      if (e.shiftKey) aux.setAllNotes(aux.openNotes.length === 0);
      else if (p) aux.toggleNote(p);
      return;
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

const stopPointer = (e: React.PointerEvent) => {
  e.stopPropagation();
  e.preventDefault();
};

interface NodeViewProps {
  box: Box;
  kind: LayoutKind;
  selected: boolean;
  isPrimary: boolean;
  isEditing: boolean;
  descendants: number;
  noteOpen: boolean;
  revealed: boolean;
  /** 가리기 모드에서 아직 드러나지 않은 노드 */
  masked: boolean;
  /** 가리기 모드에서 빈칸을 가리는 중이면 이미 드러낸 키 집합 */
  clozeRevealed: ReadonlySet<string> | null;
  hideActive: boolean;
  backlinkCount: number;
  drop: DropZone | null;
  onPointerDown: (e: React.PointerEvent, id: string) => void;
}

const NodeView = memo(function NodeView({
  box,
  kind,
  selected,
  isPrimary,
  isEditing,
  descendants,
  noteOpen,
  revealed,
  masked,
  clozeRevealed,
  hideActive,
  backlinkCount,
  drop,
  onPointerDown,
}: NodeViewProps) {
  const n = box.node;
  const tags = getTags(n);
  const collapsed = isCollapsed(n) && !revealed;
  const custom = resolveColor(n.attrs.color);
  const accent = custom ?? branchColor(box.branch);
  const cls = [
    'node',
    `depth-${Math.min(box.depth, 2)}`,
    selected && 'selected',
    isPrimary && 'primary',
    isEditing && 'editing',
    masked && 'masked',
    custom && 'custom-color',
    drop && `drop-${drop}`,
  ]
    .filter(Boolean)
    .join(' ');
  const foldSide = box.side === -1 ? 'left' : 'right';
  const showFold = n.children.length > 0 && !(box.depth === 0 && kind === 'mindmap') && !hideActive;

  return (
    <div
      className={cls}
      data-node-id={n.id}
      style={{ left: box.x, top: box.y, ['--accent' as string]: accent }}
      onPointerDown={(e) => onPointerDown(e, n.id)}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (!isEditLocked()) useStore.getState().startEdit(n.id);
      }}
    >
      {isPrimary && <NodeEditor node={n} editing={isEditing} />}
      {!isEditing && (
        <div className="node-text">
          <NodeText text={n.text} mask={clozeRevealed ? { nodeId: n.id, revealed: clozeRevealed } : undefined} />
        </div>
      )}
      {(tags.length > 0 || n.note !== null || backlinkCount > 0) && !isEditing && !masked && (
        <div className="node-meta">
          {n.note !== null && (
            <button
              className={`note-badge ${noteOpen ? 'open' : ''}`}
              title="메모 열기/닫기 (F4)"
              onPointerDown={stopPointer}
              onClick={(e) => {
                e.stopPropagation();
                useAux.getState().toggleNote(n.id);
              }}
            >
              📌
            </button>
          )}
          {backlinkCount > 0 && (
            <button
              className="bl-badge"
              title="이 노드를 가리키는 곳 보기"
              onPointerDown={stopPointer}
              onClick={(e) => {
                e.stopPropagation();
                useAux.getState().openBacklinks(n.id);
              }}
            >
              ↩ {backlinkCount}
            </button>
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
    if (!isOverlayOpen()) ref.current?.focus({ preventScroll: true });
  }, [node.id, editing]);

  const beginByTyping = () => {
    if (editing || isOverlayOpen() || isEditLocked()) return;
    startedByTyping.current = true;
    useStore.getState().startEdit(node.id);
  };

  return (
    <textarea
      ref={ref}
      data-sink=""
      inputMode={editing ? undefined : 'none'}
      className={editing ? 'node-input' : 'node-sink'}
      value={draft}
      rows={1}
      spellCheck={false}
      aria-label="주제 편집"
      onChange={(e) => {
        if (!editing && (isOverlayOpen() || isEditLocked())) {
          e.target.value = '';
          return;
        }
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
        if (editing || isEditLocked()) return;
        const t = commands.copyText();
        if (t === null) return;
        e.preventDefault();
        e.clipboardData.setData('text/plain', t);
        commands.remove();
      }}
      onPaste={(e) => {
        if (editing || isEditLocked()) {
          if (!editing) e.preventDefault();
          return;
        }
        e.preventDefault();
        commands.paste(e.clipboardData.getData('text/plain'));
      }}
    />
  );
}
