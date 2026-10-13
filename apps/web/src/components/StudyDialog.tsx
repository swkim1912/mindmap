import { useEffect, useMemo, useRef } from 'react';
import { buildCards, collectTags, findNode, type Card } from '@mindmap/core';
import { useStore } from '../store';
import { useAux } from '../workspace';
import { useStudy } from '../study';
import { NodeText } from './NodeText';

/** 카드 복습: 설정 화면과 복습 세션 화면 */
export function StudyDialog() {
  const setup = useStudy((s) => s.setup);
  const session = useStudy((s) => s.session);
  if (session) return <SessionView />;
  if (setup) return <SetupView />;
  return null;
}

// ---------------------------------------------------------------- 설정

function SetupView() {
  const setup = useStudy((s) => s.setup)!;
  const records = useStudy((s) => s.records);
  const doc = useStore((s) => s.map?.doc);
  const mapPath = useStore((s) => s.map?.path ?? '');
  const startRef = useRef<HTMLButtonElement>(null);

  const tags = useMemo(() => (doc ? collectTags(doc) : []), [doc]);
  const scopeNode = doc && setup.scopeId ? findNode(doc.root, setup.scopeId) : null;
  // 범위로 쓰던 노드가 사라졌다면 맵 전체로 본다
  const scopeId = scopeNode ? setup.scopeId : null;

  const all = useMemo(
    () => (doc ? buildCards(doc, { rootId: scopeId ?? undefined, tag: setup.tag, includeChildren: setup.includeChildren }) : []),
    [doc, scopeId, setup.tag, setup.includeChildren],
  );
  const stats = useMemo(() => {
    let fresh = 0;
    let unknown = 0;
    let known = 0;
    for (const c of all) {
      const r = records[c.id];
      if (!r) fresh++;
      else if (r.lastKnown) known++;
      else unknown++;
    }
    return { fresh, unknown, known };
  }, [all, records]);
  const cards = setup.onlyUnknown ? all.filter((c) => !records[c.id]?.lastKnown) : all;

  useEffect(() => {
    const t = setTimeout(() => startRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, []);

  const close = () => useStudy.getState().closeSetup();
  const start = () => useStudy.getState().startSession(cards, setup.shuffle);
  const patch = useStudy.getState().patchSetup;

  return (
    <div className="modal-backdrop" onMouseDown={close} onKeyDown={(e) => e.key === 'Escape' && close()}>
      <div className="modal study-setup" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="카드 복습 설정">
        <div className="modal-head">
          <h2>🃏 카드 복습</h2>
          <button onClick={close} aria-label="닫기">
            ✕
          </button>
        </div>
        <p className="hint">{mapPath.replace(/\.mm\.md$/, '')}</p>

        <fieldset>
          <legend>범위</legend>
          <label>
            <input type="radio" checked={scopeId === null} onChange={() => patch({ scopeId: null })} /> 맵 전체
          </label>
          <label className={scopeNode ? '' : 'disabled'}>
            <input
              type="radio"
              disabled={!scopeNode}
              checked={scopeId !== null}
              onChange={() => {
                const p = useStore.getState().primary;
                if (p) patch({ scopeId: p });
              }}
            />{' '}
            선택한 노드 아래{scopeNode ? `: “${scopeNode.text.split('\n')[0].slice(0, 24)}”` : ' (루트가 선택되어 있음)'}
          </label>
          {tags.length > 0 && (
            <label>
              태그{' '}
              <select value={setup.tag ?? ''} onChange={(e) => patch({ tag: e.target.value || null })}>
                <option value="">전체</option>
                {tags.map((t) => (
                  <option key={t} value={t}>
                    #{t}
                  </option>
                ))}
              </select>
            </label>
          )}
        </fieldset>

        <fieldset>
          <legend>카드 종류</legend>
          <p className="hint inline">
            <code>질문 :: 답</code> 과 <code>==빈칸==</code> 은 항상 카드가 됩니다.
          </p>
          <label>
            <input type="checkbox" checked={setup.includeChildren} onChange={(e) => patch({ includeChildren: e.target.checked })} />{' '}
            노드 → 하위 항목 카드도 만들기 (“하위 항목을 떠올려 보세요”)
          </label>
        </fieldset>

        <fieldset>
          <legend>옵션</legend>
          <label>
            <input type="checkbox" checked={setup.onlyUnknown} onChange={(e) => patch({ onlyUnknown: e.target.checked })} /> 새 카드와 모르는
            카드만
          </label>
          <label>
            <input type="checkbox" checked={setup.shuffle} onChange={(e) => patch({ shuffle: e.target.checked })} /> 순서 섞기
          </label>
        </fieldset>

        <p className="study-count">
          <strong>{cards.length}장</strong>
          <span>
            {' '}
            (새 카드 {stats.fresh} · 모르는 카드 {stats.unknown} · 아는 카드 {stats.known})
          </span>
        </p>
        {all.length === 0 && (
          <p className="hint">
            이 범위에는 카드가 없습니다. 노드를 <code>앞면 :: 뒷면</code> 으로 쓰거나 외울 부분을 <code>==이렇게==</code> 감싸 보세요.
          </p>
        )}

        <div className="modal-actions">
          <button onClick={close}>취소</button>
          <button ref={startRef} className="primary" disabled={cards.length === 0} onClick={start}>
            시작
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 세션

const SWIPE = 80;

function SessionView() {
  const s = useStudy((st) => st.session)!;
  const records = useStudy((st) => st.records);
  const box = useRef<HTMLDivElement>(null);
  const swipeFrom = useRef<number | null>(null);

  const card = s.queue[0] as Card | undefined;
  const done = s.queue.length === 0;
  const total = s.cards.length;
  const remaining = new Set(s.queue.map((c) => c.id)).size;
  const learned = total - remaining;

  useEffect(() => {
    const t = setTimeout(() => box.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [done]);

  const st = useStudy.getState();
  const end = () => st.endSession();
  const showInMap = (c: Card) => {
    st.endSession();
    useAux.getState().focusNode(c.nodeId);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    const k = e.key;
    if (k === 'Escape') {
      e.preventDefault();
      end();
    } else if (done) {
      return;
    } else if (!s.flipped && (k === ' ' || k === 'Enter' || k === 'ArrowUp' || k === 'ArrowDown')) {
      e.preventDefault();
      st.flip();
    } else if (s.flipped && (k === '1' || k === 'ArrowLeft' || k === 'x' || k === 'X')) {
      e.preventDefault();
      st.answer(false);
    } else if (s.flipped && (k === '2' || k === 'ArrowRight' || k === 'o' || k === 'O')) {
      e.preventDefault();
      st.answer(true);
    } else if (s.flipped && (k === ' ' || k === 'Enter')) {
      e.preventDefault(); // 실수로 넘기지 않게 막는다 (알았음/몰랐음을 눌러야 함)
    }
  };

  // 터치/마우스 스와이프: 뒷면에서 오른쪽 = 알았음, 왼쪽 = 몰랐음. 앞면에서는 탭하면 뒤집힘
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button, a, .wikilink')) return;
    swipeFrom.current = e.clientX;
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const from = swipeFrom.current;
    swipeFrom.current = null;
    if (from === null || done) return;
    const dx = e.clientX - from;
    if (s.flipped && Math.abs(dx) >= SWIPE) st.answer(dx > 0);
    else if (!s.flipped && Math.abs(dx) < 10) st.flip();
  };

  if (done) {
    const missed = s.cards.filter((c) => s.missed.has(c.id));
    return (
      <div className="modal-backdrop study-backdrop">
        <div className="study-card summary" ref={box} tabIndex={-1} onKeyDown={onKeyDown}>
          <h2>복습 완료 🎉</h2>
          <p className="study-count">
            <strong>{total}장</strong> 중 <strong>{s.firstTry}장</strong>을 한 번에 맞혔습니다
            {missed.length > 0 && <span> · 다시 본 카드 {missed.length}장</span>}
          </p>
          {missed.length > 0 && (
            <ul className="missed-list">
              {missed.map((c) => (
                <li key={c.id}>
                  <button className="link" onClick={() => showInMap(c)} title="맵에서 보기">
                    <NodeText text={c.front} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="modal-actions">
            {missed.length > 0 && (
              <button className="primary" onClick={() => st.restartMissed()}>
                몰랐던 카드 다시 ({missed.length})
              </button>
            )}
            <button onClick={end}>닫기</button>
          </div>
        </div>
      </div>
    );
  }

  const rec = card ? records[card.id] : undefined;
  return (
    <div className="modal-backdrop study-backdrop">
      <div className="study-card" ref={box} tabIndex={-1} onKeyDown={onKeyDown} onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
        <div className="study-top">
          <progress value={learned} max={Math.max(total, 1)} />
          <span className="hint">
            {learned}/{total} 완료 · 남은 {remaining}
          </span>
          <button onClick={end} title="복습 끝내기 (Esc)" aria-label="끝내기">
            ✕
          </button>
        </div>

        {card && (
          <>
            {card.trail.length > 0 && <div className="study-trail">{card.trail.join(' › ')}</div>}
            <div className="card-face front">
              <NodeText text={card.front} />
            </div>
            {s.flipped ? (
              <div className="card-face back">
                <NodeText text={card.back} />
              </div>
            ) : (
              <div className="card-face placeholder-back">탭하거나 Space 를 눌러 답 보기</div>
            )}
            <div className="study-meta">
              <span className="kind">{card.kind === 'qa' ? '질문/답' : card.kind === 'cloze' ? '빈칸' : '하위 항목'}</span>
              {rec && (
                <span className="hint">
                  지난 결과: {rec.lastKnown ? '알았음' : '몰랐음'} · {rec.reviews}회 복습
                </span>
              )}
              <button className="link" onClick={() => showInMap(card)} title="이 카드의 노드를 맵에서 보기">
                맵에서 보기
              </button>
            </div>
            <div className="study-actions">
              {s.flipped ? (
                <>
                  <button className="wrong" onClick={() => st.answer(false)} title="1 또는 ←">
                    몰랐음 <kbd>1</kbd>
                  </button>
                  <button className="right" onClick={() => st.answer(true)} title="2 또는 →">
                    알았음 <kbd>2</kbd>
                  </button>
                </>
              ) : (
                <button className="primary" onClick={() => st.flip()}>
                  답 보기 <kbd>Space</kbd>
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
