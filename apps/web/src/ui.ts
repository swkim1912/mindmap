import { create } from 'zustand';
import type { TreeEntry } from './types';

export interface TreeMenuState {
  /** 메뉴를 연 항목. null 이면 맨 위(최상위) */
  entry: TreeEntry | null;
  x: number;
  y: number;
}

interface Ui {
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
