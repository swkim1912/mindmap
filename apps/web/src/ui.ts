import { create } from 'zustand';
import type { TreeEntry } from './types';

export interface TreeMenuState {
  /** 메뉴를 연 항목. null 이면 맨 위(최상위) */
  entry: TreeEntry | null;
  x: number;
  y: number;
}

/** 편집 중인 글자에 대한 동작 (편집기가 만들어서 메뉴에 넘긴다) */
export interface TextOps {
  hasSel: boolean;
  /** 선택한 글자(없으면 커서가 있는 낱말)를 open…close 로 감싼다. 이미 감싸져 있으면 벗긴다 */
  wrap(open: string, close: string): void;
  copy(): void;
  cut(): void;
  paste(): void;
}

export interface CtxMenuState {
  x: number;
  y: number;
  nodeId: string;
  /** 노드 글자를 고치는 중에 연 메뉴면 글자용 동작이 들어 있다 */
  text: TextOps | null;
}

const SIDEBAR_KEY = 'mindmap.sidebarHidden';
function loadSidebarHidden(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === '1';
  } catch {
    return false;
  }
}

interface Ui {
  /** 넓은 화면에서 사이드바를 접었는지 (기억해 둔다) */
  sidebarHidden: boolean;
  setSidebarHidden(v: boolean): void;

  /** 맵 위(노드·글자)에서 오른쪽 클릭으로 여는 메뉴 */
  ctx: CtxMenuState | null;
  openCtx(m: CtxMenuState | null): void;

  /** 좁은 화면에서 사이드바(맵 목록)를 서랍처럼 여닫는 상태 */
  drawer: boolean;
  setDrawer(v: boolean): void;

  /** 사이드바 항목의 메뉴·이동·삭제 대화상자 (서랍의 transform 영향을 피하려고 앱 최상위에서 그린다) */
  menu: TreeMenuState | null;
  moveFor: TreeEntry | null;
  deleteFor: TreeEntry | null;
  /** 이름을 그 자리에서 고치는 중인 항목의 경로 */
  renaming: string | null;
  /** 휴지통에 있는 묶음 수 (사이드바 표시용) */
  trashCount: number;

  openMenu(m: TreeMenuState | null): void;
  setMoveFor(e: TreeEntry | null): void;
  setDeleteFor(e: TreeEntry | null): void;
  setRenaming(p: string | null): void;
  setTrashCount(n: number): void;
}

export const useUi = create<Ui>((set) => ({
  sidebarHidden: loadSidebarHidden(),
  setSidebarHidden: (sidebarHidden) => {
    try {
      localStorage.setItem(SIDEBAR_KEY, sidebarHidden ? '1' : '0');
    } catch {
      /* 저장소를 못 써도 이번 화면에서는 접힌다 */
    }
    set({ sidebarHidden });
  },
  ctx: null,
  openCtx: (ctx) => set({ ctx }),
  drawer: false,
  setDrawer: (drawer) => set({ drawer }),
  menu: null,
  moveFor: null,
  deleteFor: null,
  renaming: null,
  trashCount: 0,
  openMenu: (menu) => set({ menu }),
  setMoveFor: (moveFor) => set({ moveFor, menu: null }),
  setDeleteFor: (deleteFor) => set({ deleteFor, menu: null }),
  setRenaming: (renaming) => set({ renaming, menu: null }),
  setTrashCount: (trashCount) => set({ trashCount }),
}));
