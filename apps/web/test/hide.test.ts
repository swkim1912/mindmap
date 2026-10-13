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
