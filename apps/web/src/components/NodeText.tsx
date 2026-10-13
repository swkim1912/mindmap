import { memo, type ReactNode } from 'react';
import katex from 'katex';

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

function linkLabel(inner: string): string {
  const [target, label] = inner.split('|');
  if (label) return label;
  const name = target.split('/').pop()!.replace(/\.mm(#.*)?$/, '').replace(/#\^.*$/, '');
  return name || target;
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
    else if (link)
      out.push(
        <span key={k} className="wikilink" title={link.slice(2, -2)}>
          {linkLabel(link.slice(2, -2))}
        </span>,
      );
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
