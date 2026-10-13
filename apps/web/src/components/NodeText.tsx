import { memo, type ReactNode } from 'react';
import katex from 'katex';
import { parseWikiLink } from '@mindmap/core';
import { useAux } from '../workspace';
import { linkLabel } from '../markdown';
import { useStore } from '../store';

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

function renderInline(text: string, keyPrefix = ''): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const k = `${keyPrefix}${i++}`;
    if (m.index > last) out.push(text.slice(last, m.index));
    const [tok, math, cloze, bold, italic, code, link, sep] = m;
    if (math) out.push(<span key={k} className="math" dangerouslySetInnerHTML={{ __html: renderMath(math.slice(1, -1)) }} />);
    else if (cloze) out.push(<mark key={k} className="cloze">{renderInline(cloze.slice(2, -2), k)}</mark>);
    else if (bold) out.push(<strong key={k}>{renderInline(bold.slice(2, -2), k)}</strong>);
    else if (italic) out.push(<em key={k}>{renderInline(italic.slice(1, -1), k)}</em>);
    else if (code) out.push(<code key={k}>{code.slice(1, -1)}</code>);
    else if (link) out.push(<WikiLinkChip key={k} inner={link.slice(2, -2)} />);
    else if (sep) out.push(<span key={k} className="card-sep">→</span>);
    else out.push(tok);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export const NodeText = memo(function NodeText({ text }: { text: string }) {
  if (!text) return <span className="placeholder">(빈 주제)</span>;
  const lines = text.split('\n');
  return (
    <>
      {lines.map((l, i) => (
        <span key={i} className="line">
          {renderInline(l, `${i}-`)}
        </span>
      ))}
    </>
  );
});
