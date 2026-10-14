import { memo, type ReactNode } from 'react';
import katex from 'katex';
import { parseWikiLink } from '@mindmap/core';
import { useAux } from '../workspace';
import { linkLabel } from '../markdown';
import { useStore } from '../store';
import { useStudy } from '../study';

const TOKEN_RE =
  /(\$[^$\n]+\$)|(==[^=\n]+==)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)|(`[^`\n]+`)|(\[\[[^\]\n]+\]\])|( :: )/g;

const mathCache = new Map<string, string>();
function renderMath(src: string): string {
  let html = mathCache.get(src);
  if (html === undefined) {
    html = katex.renderToString(src, { throwOnError: false, output: 'html' });
    mathCache.set(src, html);
  }
  return html;
}

/** 노드 안의 [[링크]]: ↗ 를 누르거나 Ctrl+클릭하면 이동. 대상이 없으면 깨진 링크로 표시 */
function WikiLinkChip({ inner }: { inner: string }) {
  const link = parseWikiLink(inner);
  const lookup = useAux((s) => s.lookup);
  const mapPath = useStore((s) => s.map?.path ?? '');
  const broken = !lookup.resolve(link, mapPath);
  const follow = () => void useAux.getState().followLink(link, mapPath);
  return (
    <span
      className={`wikilink ${broken ? 'broken' : ''}`}
      title={broken ? `대상을 찾을 수 없음: ${inner}` : `${inner}  (Ctrl+클릭으로 열기)`}
      onClick={(e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.stopPropagation();
        follow();
      }}
    >
      {linkLabel(link.target, link.label)}
      <button
        className="link-go"
        aria-label="링크 열기"
        onPointerDown={(e) => {
          e.stopPropagation();
          e.preventDefault();
        }}
        onClick={(e) => {
          e.stopPropagation();
          follow();
        }}
      >
        ↗
      </button>
    </span>
  );
}

/** 가리기 모드에서 빈칸을 가리기 위한 정보. 빈칸 번호는 텍스트 안의 등장 순서(core 의 hideItems 와 같음) */
export interface ClozeMask {
  nodeId: string;
  /** 가리기 모드 안의 노드면 이미 드러낸 키 집합 (그 밖에는 null) */
  revealed: ReadonlySet<string> | null;
  /** 가리기 모드 밖의 상태: all 이면 기본이 "가림", flipped 는 반대로 뒤집은 빈칸 */
  all: boolean;
  flipped: ReadonlySet<string>;
}

interface InlineCtx {
  mask: ClozeMask;
  counter: { n: number };
}

function renderInline(text: string, keyPrefix = '', ctx?: InlineCtx): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const k = `${keyPrefix}${i++}`;
    if (m.index > last) out.push(text.slice(last, m.index));
    const [tok, math, cloze, bold, italic, code, link, sep] = m;
    if (math) out.push(<span key={k} className="math" dangerouslySetInnerHTML={{ __html: renderMath(math.slice(1, -1)) }} />);
    else if (cloze) {
      const key = ctx ? `c:${ctx.mask.nodeId}#${ctx.counter.n++}` : null;
      const m = ctx?.mask;
      const inHide = !!m?.revealed;
      const hidden = key !== null && m !== undefined && (m.revealed ? !m.revealed.has(key) : m.all !== m.flipped.has(key));
      out.push(
        <mark
          key={k}
          className={`cloze ${hidden ? 'cloze-hidden' : key !== null ? 'cloze-open' : ''}`}
          title={key === null ? undefined : hidden ? '클릭해서 보기' : '클릭해서 가리기'}
          // 가리기 모드에서는 노드 자체의 탭 처리와 겹치지 않게 누르는 즉시 처리하고,
          // 평소에는 클릭으로 처리해서 노드 선택·끌기는 그대로 동작하게 한다
          onPointerDown={
            inHide
              ? (e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  useStudy.getState().toggle(key!);
                }
              : undefined
          }
          onClick={
            key !== null && !inHide
              ? (e) => {
                  e.stopPropagation();
                  useStudy.getState().toggleCloze(key);
                }
              : undefined
          }
        >
          {renderInline(cloze.slice(2, -2), k, ctx)}
        </mark>,
      );
    } else if (bold) out.push(<strong key={k}>{renderInline(bold.slice(2, -2), k, ctx)}</strong>);
    else if (italic) out.push(<em key={k}>{renderInline(italic.slice(1, -1), k, ctx)}</em>);
    else if (code) out.push(<code key={k}>{code.slice(1, -1)}</code>);
    else if (link) out.push(<WikiLinkChip key={k} inner={link.slice(2, -2)} />);
    else if (sep) out.push(<span key={k} className="card-sep">→</span>);
    else out.push(tok);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export const NodeText = memo(function NodeText({ text, mask }: { text: string; mask?: ClozeMask }) {
  if (!text) return <span className="placeholder">(빈 주제)</span>;
  const lines = text.split('\n');
  const ctx: InlineCtx | undefined = mask ? { mask, counter: { n: 0 } } : undefined;
  return (
    <>
      {lines.map((l, i) => (
        <span key={i} className="line">
          {renderInline(l, `${i}-`, ctx)}
        </span>
      ))}
    </>
  );
});
