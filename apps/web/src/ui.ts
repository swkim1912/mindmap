import { create } from 'zustand';

/** 좁은 화면에서 사이드바(맵 목록)를 서랍처럼 여닫는 상태 */
export const useUi = create<{ drawer: boolean; setDrawer: (v: boolean) => void }>((set) => ({
  drawer: false,
  setDrawer: (drawer) => set({ drawer }),
}));
