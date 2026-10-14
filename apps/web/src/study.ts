/**
 * 암기 기능의 상태: 가리기 모드(맵 위에서)와 카드 복습 세션.
 */
import { create } from 'zustand';
import {
  applyResult,
  hideItems,
  nextHidden,
  shuffled,
  subtreeIds,
  type Card,
  type StudyRecord,
} from '@mindmap/core';
import { api } from './api';
import { useStore } from './store';
import { useAux } from './workspace';

export interface HideState {
  /** 이 노드의 하위를 가린다 (노드 자신의 텍스트는 질문처럼 보임) */
  scopeId: string;
  scope: ReadonlySet<string>;
  /** 이미 드러낸 항목 키 (n:노드 / c:노드#번호 / m:노드) */
  revealed: ReadonlySet<string>;
}

export interface SetupOptions {
  /** null 이면 맵 전체 */
  scopeId: string | null;
  tag: string | null;
  includeChildren: boolean;
  onlyUnknown: boolean;
  shuffle: boolean;
}

export interface Session {
  mapPath: string;
  /** 이번 세션에 나온 모든 카드 */
  cards: Card[];
  /** 남은 카드. 맨 앞이 지금 보는 카드 */
  queue: Card[];
  flipped: boolean;
  /** 한 번이라도 모른다고 답한 카드 ID */
  missed: ReadonlySet<string>;
  /** 처음 본 순간 바로 맞힌 카드 수 */
  firstTry: number;
  answers: number;
}

/** 가리기 모드가 아닐 때의 빈칸 표시 상태: all 이면 기본이 "가림", flipped 는 그 반대로 뒤집은 빈칸 */
export interface ClozeView {
  all: boolean;
  flipped: ReadonlySet<string>;
}

const NO_FLIPS: ReadonlySet<string> = new Set();

interface Study {
  cloze: ClozeView;
  /** 가리기 모드 밖에서 빈칸 하나를 가렸다 열었다 한다 */
  toggleCloze(key: string): void;
  /** 모든 빈칸을 가리거나(true) 연다(false). 가리기 모드 중에는 모드 안의 빈칸에 적용 */
  setAllClozes(hidden: boolean): void;
  /** 지금 가려진 빈칸이 하나라도 있는지 (버튼 이름 결정용) */
  anyClozeHidden(): boolean;

  hide: HideState | null;
  setup: SetupOptions | null;
  records: Record<string, StudyRecord>;
  session: Session | null;

  enterHide(scopeId?: string | null): void;
  exitHide(): void;
  reveal(key: string): void;
  /** 이미 드러났으면 다시 가리고, 가려져 있으면 드러낸다 */
  toggle(key: string): void;
  revealNext(fromNodeId: string | null): void;
  revealAll(): void;
  resetHide(): void;

  openSetup(): Promise<void>;
  patchSetup(patch: Partial<SetupOptions>): void;
  closeSetup(): void;
  startSession(cards: Card[], shuffle: boolean): void;
  flip(): void;
  answer(known: boolean): void;
  endSession(): void;
  restartMissed(): void;
}

let postFailedToasted = false;

export const useStudy = create<Study>()((set, get) => ({
  cloze: { all: false, flipped: NO_FLIPS },

  toggleCloze(key) {
    const c = get().cloze;
    const flipped = new Set(c.flipped);
    if (!flipped.delete(key)) flipped.add(key);
    set({ cloze: { ...c, flipped } });
  },

  setAllClozes(hidden) {
    const h = get().hide;
    const m = useStore.getState().map;
    if (h && m) {
      const keys = new Set(h.revealed);
      for (const it of hideItems(m.doc, h.scopeId)) {
        if (it.kind !== 'cloze') continue;
        if (hidden) keys.delete(it.key);
        else keys.add(it.key);
      }
      set({ hide: { ...h, revealed: keys } });
    }
    // 모드 밖(혹은 모드 범위 밖)의 빈칸도 같은 상태로 맞춘다
    set({ cloze: { all: hidden, flipped: NO_FLIPS } });
  },

  anyClozeHidden() {
    const { hide: h, cloze: c } = get();
    const m = useStore.getState().map;
    if (h && m) return hideItems(m.doc, h.scopeId).some((it) => it.kind === 'cloze' && !h.revealed.has(it.key));
    return c.all || c.flipped.size > 0;
  },

  hide: null,
  setup: null,
  records: {},
  session: null,

  // ---------- 가리기 모드 ----------
  enterHide(scopeId) {
    const m = useStore.getState().map;
    if (!m) return;
    const id = scopeId ?? useStore.getState().primary ?? m.doc.root.id;
    if (hideItems(m.doc, id).length === 0) {
      useStore.getState().toast('이 노드 아래에는 가릴 내용이 없습니다', 'error');
      return;
    }
    set({ hide: { scopeId: id, scope: subtreeIds(m.doc.root, id), revealed: new Set() } });
  },

  exitHide() {
    set({ hide: null });
  },

  reveal(key) {
    const h = get().hide;
    if (!h || h.revealed.has(key)) return;
    set({ hide: { ...h, revealed: new Set(h.revealed).add(key) } });
  },

  toggle(key) {
    const h = get().hide;
    if (!h) return;
    const next = new Set(h.revealed);
    if (!next.delete(key)) next.add(key);
    set({ hide: { ...h, revealed: next } });
  },

  revealNext(fromNodeId) {
    const h = get().hide;
    const m = useStore.getState().map;
    if (!h || !m) return;
    const items = hideItems(m.doc, h.scopeId);
    const it = nextHidden(items, h.revealed, fromNodeId);
    if (!it) {
      useStore.getState().toast('모두 드러났습니다. "다시 가리기"로 처음부터 연습하세요');
      return;
    }
    get().reveal(it.key);
    if (it.kind === 'note') {
      useAux.setState((s) => (s.openNotes.includes(it.nodeId) ? s : { openNotes: [...s.openNotes, it.nodeId] }));
    }
    useStore.getState().select(it.nodeId);
  },

  revealAll() {
    const h = get().hide;
    const m = useStore.getState().map;
    if (!h || !m) return;
    const keys = new Set(h.revealed);
    for (const it of hideItems(m.doc, h.scopeId)) keys.add(it.key);
    set({ hide: { ...h, revealed: keys } });
  },

  resetHide() {
    const h = get().hide;
    if (h) set({ hide: { ...h, revealed: new Set() } });
  },

  // ---------- 카드 복습 ----------
  async openSetup() {
    const st = useStore.getState();
    if (!st.map) return;
    set({ hide: null });
    const primary = st.primary && st.primary !== st.map.doc.root.id ? st.primary : null;
    set({
      setup: { scopeId: primary, tag: null, includeChildren: false, onlyUnknown: false, shuffle: true },
      records: {},
    });
    try {
      const records = await api.study(st.map.path);
      if (get().setup) set({ records });
    } catch {
      /* 기록을 못 읽어도 복습은 할 수 있다 */
    }
  },

  patchSetup(patch) {
    const s = get().setup;
    if (s) set({ setup: { ...s, ...patch } });
  },

  closeSetup() {
    set({ setup: null });
  },

  startSession(cards, shuffle) {
    const m = useStore.getState().map;
    if (!m || cards.length === 0) return;
    const queue = shuffle ? shuffled(cards) : [...cards];
    set({
      setup: null,
      session: { mapPath: m.path, cards, queue, flipped: false, missed: new Set(), firstTry: 0, answers: 0 },
    });
  },

  flip() {
    const s = get().session;
    if (s && s.queue.length) set({ session: { ...s, flipped: !s.flipped } });
  },

  answer(known) {
    const s = get().session;
    if (!s || !s.queue.length || !s.flipped) return;
    const card = s.queue[0];
    const rest = s.queue.slice(1);
    const missed = new Set(s.missed);
    if (!known) missed.add(card.id);
    set({
      records: { ...get().records, [card.id]: applyResult(get().records[card.id], known, new Date().toISOString()) },
      session: {
        ...s,
        // 아는 카드는 빠지고, 모르는 카드는 줄 맨 뒤에서 다시 나온다
        queue: known ? rest : [...rest, card],
        flipped: false,
        missed,
        firstTry: s.firstTry + (known && !s.missed.has(card.id) ? 1 : 0),
        answers: s.answers + 1,
      },
    });
    api.recordStudy(s.mapPath, [{ id: card.id, known }]).catch((e: Error) => {
      if (postFailedToasted) return;
      postFailedToasted = true;
      useStore.getState().toast(`복습 기록을 저장하지 못했습니다: ${e.message}`, 'error');
    });
  },

  endSession() {
    set({ session: null });
  },

  restartMissed() {
    const s = get().session;
    if (!s) return;
    const cards = s.cards.filter((c) => s.missed.has(c.id));
    get().startSession(cards, true);
  },
}));

// 맵을 바꾸면 가리기 모드/복습 화면을 닫는다
useStore.subscribe((s, prev) => {
  if (s.map?.path === prev.map?.path) return;
  useStudy.setState({ hide: null, setup: null, session: null, cloze: { all: false, flipped: NO_FLIPS } });
});
