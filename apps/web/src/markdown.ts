import { Marked, type TokenizerAndRendererExtension } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import DOMPurify from 'dompurify';
import katex from 'katex';
import { dirOf, joinPath, parseWikiLink } from '@mindmap/core';

const LANGS = { bash, c, cpp, csharp, css, go, java, javascript, json, kotlin, markdown, python, rust, sql, typescript, xml, yaml };
for (const [name, def] of Object.entries(LANGS)) hljs.registerLanguage(name, def);
const ALIASES: Record<string, string> = {
  js: 'javascript', ts: 'typescript', py: 'python', sh: 'bash', shell: 'bash', html: 'xml', md: 'markdown',
  yml: 'yaml', 'c++': 'cpp', 'c#': 'csharp', cs: 'csharp', kt: 'kotlin', rs: 'rust', golang: 'go', jsx: 'javascript', tsx: 'typescript',
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function math(src: string, display: boolean): string {
  return katex.renderToString(src, { throwOnError: false, displayMode: display, output: 'html' });
}

/** 링크 대상 표시 이름: `a/b.mm` → `b` */
export function linkLabel(target: string, label: string | null): string {
  if (label) return label;
  const name = target.slice(target.lastIndexOf('/') + 1).replace(/\.md$/, '').replace(/\.mm$/, '');
  return name || '링크';
}

const blockMath: TokenizerAndRendererExtension = {
  name: 'blockMath',
  level: 'block',
  start: (src) => src.indexOf('$$'),
  tokenizer(src) {
    const m = /^\$\$\n?([\s\S]+?)\n?\$\$(?:\n|$)/.exec(src);
    return m ? { type: 'blockMath', raw: m[0], text: m[1].trim() } : undefined;
  },
  renderer: (t) => `<div class="math-block">${math((t as unknown as { text: string }).text, true)}</div>`,
};

const inlineMath: TokenizerAndRendererExtension = {
  name: 'inlineMath',
  level: 'inline',
  start: (src) => src.indexOf('$'),
  tokenizer(src) {
    const m = /^\$(?!\s)((?:\\.|[^$\\\n])+?)(?<!\s)\$(?!\d)/.exec(src);
    return m ? { type: 'inlineMath', raw: m[0], text: m[1] } : undefined;
  },
  renderer: (t) => math((t as unknown as { text: string }).text, false),
};

const wikilink: TokenizerAndRendererExtension = {
  name: 'wikilink',
  level: 'inline',
  start: (src) => src.indexOf('[['),
  tokenizer(src) {
    const m = /^\[\[([^\]\n]+)\]\]/.exec(src);
    return m ? { type: 'wikilink', raw: m[0], inner: m[1] } : undefined;
  },
  renderer(t) {
    const l = parseWikiLink((t as unknown as { inner: string }).inner);
    return `<a class="wikilink" href="#" data-target="${esc(l.target)}" data-anchor="${esc(l.anchor ?? '')}">${esc(linkLabel(l.target, l.label))}</a>`;
  },
};

const cloze: TokenizerAndRendererExtension = {
  name: 'cloze',
  level: 'inline',
  start: (src) => src.indexOf('=='),
  tokenizer(src) {
    const m = /^==([^=\n]+)==/.exec(src);
    return m ? { type: 'cloze', raw: m[0], text: m[1] } : undefined;
  },
  renderer: (t) => `<mark class="cloze">${esc((t as unknown as { text: string }).text)}</mark>`,
};

const marked = new Marked(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      const name = ALIASES[lang?.toLowerCase()] ?? lang?.toLowerCase();
      return name && hljs.getLanguage(name) ? hljs.highlight(code, { language: name }).value : esc(code);
    },
  }),
  { gfm: true, breaks: true, extensions: [blockMath, inlineMath, wikilink, cloze] },
);

export function stripFrontmatter(src: string): string {
  return src.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

/** 상대 이미지 경로를 서버의 /api/asset 주소로 바꾼다 */
export function assetUrl(baseDir: string, ref: string): string {
  let decoded = ref;
  try {
    decoded = decodeURI(ref);
  } catch {
    /* 그대로 사용 */
  }
  return `/api/asset?path=${encodeURIComponent(joinPath(baseDir, decoded))}`;
}

const cache = new Map<string, string>();

/**
 * Markdown → 정화된 HTML. baseDir 은 이 문서가 있는 폴더(Vault 기준)로, 상대 이미지 경로 해석에 쓴다.
 * 파일 내용은 AI나 외부에서 올 수 있으므로 반드시 DOMPurify 를 거친다.
 */
export function renderMarkdown(md: string, baseDir: string): string {
  const key = `${baseDir}\u0000${md}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const raw = marked.parse(md, { async: false }) as string;
  const clean = DOMPurify.sanitize(raw, { ADD_ATTR: ['data-target', 'data-anchor'] });
  const tpl = document.createElement('template');
  tpl.innerHTML = clean;
  tpl.content.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') ?? '';
    if (/^(https?:|data:image\/)/i.test(src)) return;
    img.setAttribute('src', assetUrl(baseDir, src));
  });
  tpl.content.querySelectorAll('a[href]').forEach((a) => {
    if (a.classList.contains('wikilink')) return;
    if (/^https?:/i.test(a.getAttribute('href') ?? '')) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
  });
  const html = tpl.innerHTML;
  if (cache.size > 300) cache.clear();
  cache.set(key, html);
  return html;
}

export { dirOf };
