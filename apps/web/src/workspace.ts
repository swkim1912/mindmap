/**
 * 맵 편집 외의 상태: 링크 이동, 포스트잇, 팝업 페이지, 검색/링크 대화상자, 역링크.
 * (맵 문서 자체의 편집·저장은 store.ts)
 */
import { create } from 'zustand';
import {
  FileLookup,
  findNode,
  formatWikiLink,
  isMapPath,
  linkTargetFor,
  mapCompanionDir,
  pathTo,
  setNote,
  setText,
} from '@mindmap/core';
import { api, ApiError, type VaultEvent } from './api';
import { flushEdit } from './editing';
import { focusSink } from './controls';
import { useStore, type SaveState } from './store';
import type { BacklinkSource, Backlinks } from './types';

export type PageMode = 'split' | 'edit' | 'preview';

export interface PageState {
  path: string;
  content: string;
  /** 마지막으로 디스크에 저장된 내용 */
  saved: string;
  baseHash: string | null;
  saveState: SaveState;
  /** 저장하려는데 디스크가 외부에서 바뀐 경우 */
  conflict: { content: string; hash: string } | null;
  backlinks: BacklinkSource[];
}

export type DialogKind = 'search' | 'link' | 'backlinks' | 'portable' | 'history' | null;

interface NavEntry {
  path: string;
  nodeId: string | null;
}

interface Aux {
  files: string[];
  lookup: FileLookup;
  backlinks: Backlinks | null;

  openNotes: string[];
  noteEditing: string | null;
  revealIds: string[];
  navStack: NavEntry[];

  page: PageState | null;
  pageStack: string[];
  pageMode: PageMode;

  dialog: DialogKind;
  linkPicker: ((rawLink: string) => void) | null;
  backlinkNode: string | null;

  loadFiles(): Promise<void>;
  loadBacklinks(): Promise<void>;
  onVaultEvent(e: VaultEvent): void;

  toggleNote(id: string): void;
  setAllNotes(open: boolean): void;
  startNoteEdit(id: string): void;
  commitNote(id: string, text: string): void;
  cancelNoteEdit(id: string): void;

  followLink(link: { target: string; anchor: string | null }, fromPath: string): Promise<void>;
  goMap(path: string, nodeId: string | null, opts?: { push?: boolean }): Promise<void>;
  back(): Promise<void>;
  focusNode(id: string): void;

  openPage(path: string, opts?: { push?: boolean }): Promise<void>;
  pageBack(): Promise<void>;
  closePage(): Promise<void>;
  setPageContent(content: string): void;
  setPageMode(mode: PageMode): void;
  savePage(): Promise<void>;
  resolveConflict(choice: 'mine' | 'disk'): void;
  createPageForNode(id: string): Promise<void>;
  /** 노드 동작: 연결된 페이지/링크가 있으면 열고, 없으면 새 페이지를 만든다 */
  openOrCreatePage(id: string): Promise<void>;

  openSearch(): void;
  openLinkPicker(onPick: (rawLink: string) => void): void;
  openBacklinks(nodeId: string | null): void;
  openDialog(kind: 'portable' | 'history'): void;
  closeDialog(): void;
  appendLinkToNode(id: string, rawLink: string): void;
  /** 새 페이지 파일을 만들고 경로를 돌려준다 (이름이 겹치면 번호를 붙임) */
  makePage(title: string): Promise<string>;
}

const emptyLookup = new FileLookup([]);
let pageSaveTimer: ReturnType<typeof setTimeout> | undefined;
let pageSaving = false;
let pageResave = false;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

const st = () => useStore.getState();


/** 노드 텍스트에서 파일 이름으로 쓸 만한 문자열을 뽑는다 */
export function titleFromNodeText(text: string): string {
  const first = text.split('\n')[0] ?? '';
  return first
    .replace(/\[\[[^\]]*\]\]/g, '')
    .replace(/\s*::\s*/g, ' ')
    .replace(/[*=`$]/g, '')
    .replace(/[<>:"/\\|?*\x00-\x1f#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim();
}

export const useAux = create<Aux>()((set, get) => {
  const schedulePageSave = (ms = 1000) => {
    clearTimeout(pageSaveTimer);
    pageSaveTimer = setTimeout(() => void get().savePage(), ms);
  };

  const loadPageBacklinks = async (path: string) => {
    try {
      const bl = await api.backlinks(path);
      const p = get().page;
      if (p && p.path === path) set({ page: { ...p, backlinks: bl.file } });
    } catch {
      /* 역링크는 부가 정보 */
    }
  };

  return {
    files: [],
    lookup: emptyLookup,
    backlinks: null,
    openNotes: [],
    noteEditing: null,
    revealIds: [],
    navStack: [],
    page: null,
    pageStack: [],
    pageMode: 'split',
    dialog: null,
    linkPicker: null,
    backlinkNode: null,

    async loadFiles() {
      try {
        const files = await api.files();
        set({ files, lookup: new FileLookup(files) });
      } catch {
        /* 서버가 아직 준비 중일 수 있음 */
      }
    },

    async loadBacklinks() {
      const path = st().map?.path;
      if (!path) return set({ backlinks: null });
      try {
        const bl = await api.backlinks(path);
        if (st().map?.path === path) set({ backlinks: bl });
      } catch {
        /* 무시 */
      }
    },

    onVaultEvent(e) {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        void get().loadFiles();
        void get().loadBacklinks();
        const p = get().page;
        if (p) void loadPageBacklinks(p.path);
      }, 400);
      if (e.type !== 'file') return;
      const p = get().page;
      if (!p || e.path !== p.path || e.hash === p.baseHash) return;
      if (e.hash === null) {
        st().toast('열려 있는 페이지 파일이 삭제되었거나 이동되었습니다', 'error');
        set({ page: { ...p, baseHash: null } });
        return;
      }
      // 저장 안 된 편집이 없으면 디스크 내용으로 갱신, 있으면 저장 시 충돌로 처리
      if (p.content === p.saved && !pageSaving) {
        void api.read(p.path).then(({ content, hash }) => {
          const cur = get().page;
          if (cur && cur.path === p.path && cur.content === cur.saved) {
            set({ page: { ...cur, content, saved: content, baseHash: hash } });
          }
        });
      }
    },

    // ---------- 포스트잇 ----------
    toggleNote(id) {
      const m = st().map;
      const node = m && findNode(m.doc.root, id);
      if (!node) return;
      if (node.note === null) {
        st().apply((d) => setNote(d, id, ''));
        set({ openNotes: [...get().openNotes, id], noteEditing: id });
        return;
      }
      const open = get().openNotes.includes(id);
      set({
        openNotes: open ? get().openNotes.filter((x) => x !== id) : [...get().openNotes, id],
        noteEditing: open && get().noteEditing === id ? null : get().noteEditing,
      });
    },

    setAllNotes(open) {
      const m = st().map;
      if (!m) return;
      const ids: string[] = [];
      const walk = (n: typeof m.doc.root) => {
        if (n.note !== null) ids.push(n.id);
        n.children.forEach(walk);
      };
      walk(m.doc.root);
      set({ openNotes: open ? ids : [], noteEditing: open ? get().noteEditing : null });
    },

    startNoteEdit(id) {
      set({ noteEditing: id, openNotes: get().openNotes.includes(id) ? get().openNotes : [...get().openNotes, id] });
    },

    commitNote(id, text) {
      const body = text.replace(/\s+$/, '');
      const empty = body.trim() === '';
      st().apply((d) => setNote(d, id, empty ? null : body));
      set({
        noteEditing: null,
        openNotes: empty ? get().openNotes.filter((x) => x !== id) : get().openNotes,
      });
      focusSink();
    },

    cancelNoteEdit(id) {
      const node = st().map && findNode(st().map!.doc.root, id);
      // 방금 만든 빈 포스트잇은 취소하면 없앤다
      if (node && node.note === '') st().apply((d) => setNote(d, id, null));
      set({
        noteEditing: null,
        openNotes: node && node.note === '' ? get().openNotes.filter((x) => x !== id) : get().openNotes,
      });
      focusSink();
    },

    // ---------- 링크 이동 ----------
    async followLink(link, fromPath) {
      const r = get().lookup.resolve(link, fromPath);
      if (!r) {
        st().toast(`링크 대상을 찾을 수 없습니다: ${link.target || link.anchor}`, 'error');
        return;
      }
      if (isMapPath(r.path)) await get().goMap(r.path, r.nodeId);
      else await get().openPage(r.path, { push: get().page !== null });
    },

    async goMap(path, nodeId, opts) {
      flushEdit();
      await get().closePage();
      const cur = st().map;
      if (opts?.push !== false && cur) {
        set({ navStack: [...get().navStack, { path: cur.path, nodeId: st().primary }].slice(-50) });
      }
      if (!cur || cur.path !== path) {
        await st().openMap(path);
        if (st().map?.path !== path) return;
      }
      if (nodeId) get().focusNode(nodeId);
    },

    async back() {
      const stack = get().navStack;
      if (!stack.length) return;
      const prev = stack[stack.length - 1];
      set({ navStack: stack.slice(0, -1) });
      await get().goMap(prev.path, prev.nodeId, { push: false });
    },

    focusNode(id) {
      const m = st().map;
      if (!m) return;
      const trail = pathTo(m.doc.root, id);
      if (!trail.length) {
        st().toast('링크된 노드를 찾을 수 없습니다', 'error');
        return;
      }
      // 접힌 부모는 화면에서만 펼쳐 보인다 (파일의 접힘 상태는 건드리지 않는다)
      set({ revealIds: trail.slice(0, -1).map((n) => n.id) });
      st().select(id);
    },

    // ---------- 팝업 페이지 ----------
    async openPage(path, opts) {
      const cur = get().page;
      if (cur) await get().savePage();
      try {
        const { content, hash } = await api.read(path);
        set({
          page: { path, content, saved: content, baseHash: hash, saveState: 'saved', conflict: null, backlinks: [] },
          pageStack: opts?.push && cur ? [...get().pageStack, cur.path] : opts?.push ? get().pageStack : [],
        });
        void loadPageBacklinks(path);
      } catch (e) {
        st().toast(`페이지를 열 수 없습니다: ${(e as Error).message}`, 'error');
      }
    },

    async pageBack() {
      const stack = get().pageStack;
      if (!stack.length) return;
      const prev = stack[stack.length - 1];
      await get().openPage(prev);
      set({ pageStack: stack.slice(0, -1) });
    },

    async closePage() {
      if (!get().page) return;
      clearTimeout(pageSaveTimer);
      await get().savePage();
      set({ page: null, pageStack: [] });
      focusSink();
    },

    setPageContent(content) {
      const p = get().page;
      if (!p) return;
      set({ page: { ...p, content, saveState: content === p.saved ? p.saveState : 'dirty' } });
      schedulePageSave();
    },

    setPageMode(mode) {
      set({ pageMode: mode });
    },

    async savePage() {
      clearTimeout(pageSaveTimer);
      const p = get().page;
      if (!p || p.content === p.saved || p.conflict) return;
      if (pageSaving) {
        pageResave = true;
        return;
      }
      pageSaving = true;
      set({ page: { ...p, saveState: 'saving' } });
      const { path, content } = p;
      try {
        const { hash } = await api.write(path, content, p.baseHash);
        const cur = get().page;
        if (cur && cur.path === path) {
          const more = cur.content !== content;
          set({ page: { ...cur, saved: content, baseHash: hash, saveState: more ? 'dirty' : 'saved' } });
          if (more) schedulePageSave();
        }
      } catch (e) {
        const cur = get().page;
        if (cur && e instanceof ApiError && e.status === 409) {
          if (typeof e.body.content === 'string') {
            set({ page: { ...cur, saveState: 'error', conflict: { content: e.body.content, hash: e.body.hash as string } } });
          } else {
            // 파일이 삭제됨: 새로 만들어 저장
            set({ page: { ...cur, baseHash: null, saveState: 'dirty' } });
            pageResave = true;
          }
        } else if (cur) {
          set({ page: { ...cur, saveState: 'error' } });
          st().toast(`페이지 저장 실패: ${(e as Error).message}`, 'error');
          schedulePageSave(5000);
        }
      } finally {
        pageSaving = false;
        if (pageResave) {
          pageResave = false;
          void get().savePage();
        }
      }
    },

    resolveConflict(choice) {
      const p = get().page;
      if (!p?.conflict) return;
      if (choice === 'disk') {
        set({ page: { ...p, content: p.conflict.content, saved: p.conflict.content, baseHash: p.conflict.hash, conflict: null, saveState: 'saved' } });
      } else {
        set({ page: { ...p, baseHash: p.conflict.hash, conflict: null, saveState: 'dirty' } });
        void get().savePage();
      }
    },

    async makePage(title) {
      const m = st().map;
      if (!m) throw new Error('열린 맵이 없습니다');
      const base = `${mapCompanionDir(m.path)}/pages`;
      const name = titleFromNodeText(title) || '새 페이지';
      for (let n = 1; n < 100; n++) {
        const path = `${base}/${name}${n > 1 ? ` ${n}` : ''}.md`;
        try {
          await api.createPage(path, name);
          set({ files: [...get().files, path], lookup: new FileLookup([...get().files, path]) });
          return path;
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 409)) throw e;
        }
      }
      throw new Error('페이지 이름을 정하지 못했습니다');
    },

    async createPageForNode(id) {
      const m = st().map;
      const node = m && findNode(m.doc.root, id);
      if (!node) return;
      try {
        const path = await get().makePage(node.text);
        get().appendLinkToNode(id, formatWikiLink({ target: linkTargetFor(path) }));
        await get().openPage(path);
        void get().loadFiles();
      } catch (e) {
        st().toast(`페이지를 만들 수 없습니다: ${(e as Error).message}`, 'error');
      }
    },

    async openOrCreatePage(id) {
      const m = st().map;
      const node = m && findNode(m.doc.root, id);
      if (!node || !m) return;
      const links = [...node.text.matchAll(/\[\[([^\]\n]+)\]\]/g)].map((x) => x[1]);
      const lookup = get().lookup;
      let firstAny: string | null = null;
      for (const raw of links) {
        const [targetPart] = raw.split('|');
        const [target, anchor] = targetPart.split('#');
        const link = { target: target.trim(), anchor: anchor ?? null };
        const r = lookup.resolve(link, m.path);
        if (!r) continue;
        if (!isMapPath(r.path)) return get().openPage(r.path);
        firstAny ??= raw;
      }
      if (firstAny) {
        const [targetPart] = firstAny.split('|');
        const [target, anchor] = targetPart.split('#');
        return get().followLink({ target: target.trim(), anchor: anchor ?? null }, m.path);
      }
      await get().createPageForNode(id);
    },

    // ---------- 대화상자 ----------
    openSearch() {
      flushEdit();
      (document.activeElement as HTMLElement | null)?.blur?.();
      set({ dialog: 'search', linkPicker: null });
    },
    openLinkPicker(onPick) {
      flushEdit();
      (document.activeElement as HTMLElement | null)?.blur?.();
      set({ dialog: 'link', linkPicker: onPick });
    },
    openDialog(kind) {
      flushEdit();
      (document.activeElement as HTMLElement | null)?.blur?.();
      set({ dialog: kind, linkPicker: null });
    },
    openBacklinks(nodeId) {
      set({ dialog: 'backlinks', backlinkNode: nodeId });
    },
    closeDialog() {
      set({ dialog: null, linkPicker: null });
      if (!get().page) focusSink();
    },

    appendLinkToNode(id, rawLink) {
      st().apply((d) => {
        const n = findNode(d.root, id);
        if (n) setText(d, id, n.text ? `${n.text} ${rawLink}` : rawLink);
      });
    },
  };
});

// 맵이 바뀌면 맵에 묶인 화면 상태를 초기화하고 역링크를 새로 읽는다
useStore.subscribe((s, prev) => {
  if (s.map?.path === prev.map?.path) return;
  useAux.setState({ openNotes: [], noteEditing: null, revealIds: [], backlinks: null });
  void useAux.getState().loadBacklinks();
});
