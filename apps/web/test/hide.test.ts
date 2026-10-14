import { describe, expect, it } from 'vitest';
import { useStudy } from '../src/study';

describe('가리기 모드 토글', () => {
  const start = () =>
    useStudy.setState({ hide: { scopeId: 'root', scope: new Set(['root', 'a']), revealed: new Set() } });

  it('가려진 항목은 드러내고, 드러난 항목은 다시 가린다', () => {
    start();
    useStudy.getState().toggle('n:a');
    expect(useStudy.getState().hide!.revealed.has('n:a')).toBe(true);
    useStudy.getState().toggle('n:a');
    expect(useStudy.getState().hide!.revealed.has('n:a')).toBe(false);
  });

  it('다른 항목에는 영향을 주지 않는다', () => {
    start();
    useStudy.getState().toggle('n:a');
    useStudy.getState().toggle('c:a#0');
    useStudy.getState().toggle('n:a');
    expect([...useStudy.getState().hide!.revealed]).toEqual(['c:a#0']);
  });

  it('가리기 모드가 아니면 아무 일도 하지 않는다', () => {
    useStudy.setState({ hide: null });
    useStudy.getState().toggle('n:a');
    expect(useStudy.getState().hide).toBeNull();
  });
});

describe('가리기 모드 밖의 빈칸 토글', () => {
  const reset = () => useStudy.setState({ hide: null, cloze: { all: false, flipped: new Set() } });

  it('빈칸 하나를 클릭하면 가려지고, 다시 클릭하면 열린다', () => {
    reset();
    useStudy.getState().toggleCloze('c:a#0');
    expect(useStudy.getState().cloze.flipped.has('c:a#0')).toBe(true);
    expect(useStudy.getState().anyClozeHidden()).toBe(true);
    useStudy.getState().toggleCloze('c:a#0');
    expect(useStudy.getState().anyClozeHidden()).toBe(false);
  });

  it('모두 가리기 → 하나 열기 → 모두 열기', () => {
    reset();
    useStudy.getState().setAllClozes(true);
    expect(useStudy.getState().cloze).toMatchObject({ all: true });
    expect(useStudy.getState().anyClozeHidden()).toBe(true);
    useStudy.getState().toggleCloze('c:a#0'); // 이 빈칸만 열림
    expect(useStudy.getState().cloze.flipped.has('c:a#0')).toBe(true);
    useStudy.getState().setAllClozes(false);
    expect(useStudy.getState().cloze.all).toBe(false);
    expect(useStudy.getState().cloze.flipped.size).toBe(0);
    expect(useStudy.getState().anyClozeHidden()).toBe(false);
  });
});

describe('가리기 모드 안의 모든 빈칸 가리기/열기', () => {
  it('빈칸 키만 바꾸고 노드·메모 공개 상태는 건드리지 않는다', async () => {
    const { useStore } = await import('../src/store');
    const { parseMap } = await import('@mindmap/core');
    const doc = parseMap('# 루트 ^root\n\n- 가 ==x== 와 ==y== ^a\n- 나 ^b\n').doc;
    useStore.setState({ map: { path: 't.mm.md', doc, base: doc, baseHash: null, warnings: [] } });
    useStudy.setState({
      cloze: { all: false, flipped: new Set() },
      hide: { scopeId: 'root', scope: new Set(['root', 'a', 'b']), revealed: new Set(['n:b']) },
    });
    const s = useStudy.getState();
    expect(s.anyClozeHidden()).toBe(true); // c:a#0, c:a#1 이 아직 가려져 있음
    s.setAllClozes(false);
    expect([...useStudy.getState().hide!.revealed].sort()).toEqual(['c:a#0', 'c:a#1', 'n:b']);
    expect(useStudy.getState().anyClozeHidden()).toBe(false);
    useStudy.getState().setAllClozes(true);
    expect([...useStudy.getState().hide!.revealed]).toEqual(['n:b']);
    useStudy.setState({ hide: null });
    useStore.setState({ map: null });
  });
});
