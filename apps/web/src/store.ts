import { create } from 'zustand';
import { produce } from 'immer';
import {
  collectIds,
  findNode,
  mergeMaps,
  parseMap,
  serializeMap,
  type MapDoc,
  type ParseWarning,
} from '@mindmap/core';
import { api, ApiError, type VaultEvent } from './api';
import { flushEdit } from './editing';
import type { TreeEntry } from './types';

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

export interface OpenMap {
  path: string;
  doc: MapDoc;
  /** 마지막으로 디스크와 일치했던 버전 (3-way 병합의 base) */
  base: MapDoc;
  baseHash: string | null;
  warnings: ParseWarning[];
}

export interface Editing {
  id: string;
  /** 새로 만든 노드인지 (Esc로 취소하면 노드도 제거) */
  isNew: boolean;
}

interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error';
  /** 토스트에 붙는 버튼 (예: 되돌리기) */
  action?: { label: string; run: () => void };
}

interface State {
  tree: TreeEntry[];
  map: OpenMap | null;
  primary: string | null;
  selected: string[];
  editing: Editing | null;
  undoStack: MapDoc[];
  redoStack: MapDoc[];
  dirty: boolean;
  saveState: SaveState;
  toasts: Toast[];
  helpOpen: boolean;
  /** 화면을 이 노드로 스크롤하라는 요청 (값이 바뀔 때마다) */
  revealSeq: number;

  loadTree(): Promise<void>;
  openMap(path: string | null): Promise<void>;
  apply(recipe: (d: MapDoc) => void, opts?: { mergeUndo?: boolean }): void;
  undo(): void;
  redo(): void;
  select(id: string, mode?: 'replace' | 'toggle'): void;
  startEdit(id: string, isNew?: boolean): void;
  stopEdit(): void;
  cancelNewNode(): void;
  save(): Promise<void>;
  onVaultEvent(e: VaultEvent): void;
  recheckFile(): Promise<void>;
  toast(message: string, kind?: Toast['kind'], action?: Toast['action']): void;
  setHelp(open: boolean): void;
}

const UNDO_LIMIT = 200;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let saving = false;
let resaveAfter = false;
let recheckAfterSave = false;
let toastSeq = 0;

export const useStore = create<State>()((set, get) => {
  const scheduleSave = (ms = 1000) => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void get().save(), ms);
  };

  /** 문서가 바뀐 뒤 선택이 사라진 노드를 가리키지 않게 정리 */
  const fixSelection = (doc: MapDoc) => {
    const ids = collectIds(doc.root);
    const { primary, selected, editing } = get();
    const sel = selected.filter((id) => ids.has(id));
    const p = primary && ids.has(primary) ? primary : (sel[sel.length - 1] ?? doc.root.id);
    set({
      primary: p,
      selected: sel.length ? sel : [p],
      editing: editing && ids.has(editing.id) ? editing : null,
    });
  };

  const setDoc = (doc: MapDoc, extra: Partial<State> = {}) => {
    const map = get().map!;
    set({ map: { ...map, doc }, ...extra });
    fixSelection(doc);
  };

  const markDirty = () => {
    set({ dirty: true, saveState: 'dirty' });
    scheduleSave();
  };

  /** 디스크의 새 내용을 반영한다. 저장 안 된 편집이 있으면 병합. */
  const absorbExternal = (content: string, hash: string) => {
    const m = get().map;
    if (!m) return;
    const theirs = parseMap(content);
    if (!get().dirty) {
      if (serializeMap(theirs.doc) === serializeMap(m.doc)) {
        set({ map: { ...m, base: theirs.doc, baseHash: hash, warnings: theirs.warnings } });
        return;
      }
      set({
        map: { ...m, doc: theirs.doc, base: theirs.doc, baseHash: hash, warnings: theirs.warnings },
        undoStack: [...get().undoStack, m.doc].slice(-UNDO_LIMIT),
        redoStack: [],
      });
      fixSelection(theirs.doc);
      get().toast('파일이 외부에서 변경되어 다시 불러왔습니다 (Ctrl+Z로 되돌리기 가능)');
      return;
    }
    const { doc, conflicts } = mergeMaps(m.base, m.doc, theirs.doc);
    set({
      map: { ...m, doc, base: theirs.doc, baseHash: hash, warnings: theirs.warnings },
      undoStack: [...get().undoStack, m.doc].slice(-UNDO_LIMIT),
    });
    fixSelection(doc);
    get().toast(
      conflicts.length
        ? `외부 변경과 병합했습니다. 충돌 ${conflicts.length}건은 내 편집을 유지했습니다.`
        : '외부 변경과 내 편집을 병합했습니다',
    );
    markDirty();
  };

  return {
    tree: [],
    map: null,
    primary: null,
    selected: [],
    editing: null,
    undoStack: [],
    redoStack: [],
    dirty: false,
    saveState: 'saved',
    toasts: [],
    helpOpen: false,
    revealSeq: 0,

    async loadTree() {
      try {
        set({ tree: await api.tree() });
      } catch (e) {
        get().toast(`폴더 목록을 불러오지 못했습니다: ${(e as Error).message}`, 'error');
      }
    },

    async openMap(path) {
      flushEdit();
      if (get().dirty) await get().save();
      clearTimeout(saveTimer);
      if (!path) {
        set({ map: null, primary: null, selected: [], editing: null, undoStack: [], redoStack: [], dirty: false });
        return;
      }
      try {
        const { content, hash } = await api.read(path);
        const { doc, warnings } = parseMap(content);
        set({
          map: { path, doc, base: doc, baseHash: hash, warnings },
          primary: doc.root.id,
          selected: [doc.root.id],
          editing: null,
          undoStack: [],
          redoStack: [],
          dirty: false,
          saveState: 'saved',
        });
        if (location.hash.slice(1) !== encodeURI(path)) history.replaceState(null, '', `#${encodeURI(path)}`);
      } catch (e) {
        get().toast(`맵을 열 수 없습니다: ${(e as Error).message}`, 'error');
      }
    },

    apply(recipe, opts) {
      const m = get().map;
      if (!m) return;
      const next = produce(m.doc, recipe);
      if (next === m.doc) return;
      if (!opts?.mergeUndo) {
        set({ undoStack: [...get().undoStack, m.doc].slice(-UNDO_LIMIT), redoStack: [] });
      }
      setDoc(next);
      markDirty();
    },

    undo() {
      flushEdit();
      const { undoStack, map } = get();
      if (!map || !undoStack.length) return;
      const prev = undoStack[undoStack.length - 1];
      set({ undoStack: undoStack.slice(0, -1), redoStack: [...get().redoStack, map.doc], editing: null });
      setDoc(prev);
      markDirty();
    },

    redo() {
      flushEdit();
      const { redoStack, map } = get();
      if (!map || !redoStack.length) return;
      const next = redoStack[redoStack.length - 1];
      set({ redoStack: redoStack.slice(0, -1), undoStack: [...get().undoStack, map.doc], editing: null });
      setDoc(next);
      markDirty();
    },

    select(id, mode = 'replace') {
      if (get().editing?.id !== id) flushEdit();
      const { selected } = get();
      if (mode === 'toggle') {
        const has = selected.includes(id);
        const sel = has ? selected.filter((x) => x !== id) : [...selected, id];
        if (!sel.length) return;
        set({ selected: sel, primary: has ? sel[sel.length - 1] : id });
      } else {
        set({ selected: [id], primary: id, revealSeq: get().revealSeq + 1 });
      }
    },

    startEdit(id, isNew = false) {
      set({ editing: { id, isNew }, primary: id, selected: [id], revealSeq: get().revealSeq + 1 });
    },

    stopEdit() {
      set({ editing: null });
    },

    /** 방금 만든 노드의 편집을 취소: 생성 자체를 되돌린다 */
    cancelNewNode() {
      const { undoStack, map } = get();
      if (!map || !undoStack.length) return;
      const prev = undoStack[undoStack.length - 1];
      set({ undoStack: undoStack.slice(0, -1), editing: null });
      setDoc(prev);
      markDirty();
    },

    async save() {
      clearTimeout(saveTimer);
      const m = get().map;
      if (!m || !get().dirty) return;
      if (saving) {
        resaveAfter = true;
        return;
      }
      saving = true;
      set({ saveState: 'saving' });
      const doc = m.doc;
      const path = m.path;
      try {
        const { hash } = await api.write(path, serializeMap(doc), m.baseHash);
        const cur = get().map;
        if (cur && cur.path === path) {
          const stillDirty = cur.doc !== doc;
          set({ map: { ...cur, base: doc, baseHash: hash }, dirty: stillDirty, saveState: stillDirty ? 'dirty' : 'saved' });
          if (stillDirty) scheduleSave();
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && typeof e.body.content === 'string') {
          absorbExternal(e.body.content, e.body.hash as string);
          resaveAfter = true;
        } else if (e instanceof ApiError && e.status === 409) {
          // 디스크에서 삭제됨: 다음 저장(Ctrl+S) 때 새로 만든다
          const cur = get().map;
          if (cur) set({ map: { ...cur, baseHash: null } });
          set({ saveState: 'error' });
          get().toast('파일이 디스크에서 삭제되었습니다. Ctrl+S를 누르면 다시 저장합니다.', 'error');
        } else {
          set({ saveState: 'error' });
          get().toast(`저장 실패: ${(e as Error).message}`, 'error');
          scheduleSave(5000);
        }
      } finally {
        saving = false;
        if (resaveAfter) {
          resaveAfter = false;
          void get().save();
        } else if (recheckAfterSave) {
          recheckAfterSave = false;
          void get().recheckFile();
        }
      }
    },

    onVaultEvent(e) {
      if (e.type === 'tree') {
        void get().loadTree();
        return;
      }
      const m = get().map;
      if (!m || e.path !== m.path || e.hash === m.baseHash) return;
      if (saving) {
        recheckAfterSave = true;
        return;
      }
      if (e.hash === null) {
        set({ map: { ...m, baseHash: null }, saveState: 'error' });
        get().toast('열려 있는 맵 파일이 삭제되었거나 이동되었습니다. Ctrl+S로 다시 저장할 수 있습니다.', 'error');
        return;
      }
      void get().recheckFile();
    },

    async recheckFile() {
      const m = get().map;
      if (!m) return;
      try {
        const { content, hash } = await api.read(m.path);
        if (hash !== get().map?.baseHash) absorbExternal(content, hash);
      } catch {
        /* 삭제 등은 이벤트로 처리 */
      }
    },

    toast(message, kind = 'info', action) {
      const id = ++toastSeq;
      set({ toasts: [...get().toasts, { id, message, kind, action }] });
      setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), action ? 10_000 : kind === 'error' ? 7000 : 3500);
    },

    setHelp(open) {
      set({ helpOpen: open });
    },
  };
});

export function useCurrentNode(id: string | null) {
  return useStore((s) => (s.map && id ? findNode(s.map.doc.root, id) : null));
}
