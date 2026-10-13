import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import {
  buildCards,
  fromOpml,
  fromXMindContent,
  importMarkdown,
  type ImportedMarkdown,
  serializeMap,
  toAnkiCsv,
  toFreeMind,
  toOpml,
  toXMindFiles,
  type MapDoc,
} from '@mindmap/core';
import { api, ApiError } from './api';
import { mapToSvg, svgToPng } from './svgExport';

export type ExportFormat = 'md' | 'opml' | 'freemind' | 'xmind' | 'anki' | 'svg' | 'png' | 'pdf';

export const EXPORT_FORMATS: { id: ExportFormat; label: string; hint: string }[] = [
  { id: 'md', label: 'Markdown (.mm.md)', hint: '이 앱의 원본 형식 그대로' },
  { id: 'opml', label: 'OPML (.opml)', hint: '아웃라이너 앱, 다른 마인드맵 프로그램' },
  { id: 'xmind', label: 'XMind (.xmind)', hint: 'XMind 8 이후 형식' },
  { id: 'freemind', label: 'FreeMind (.mm)', hint: 'FreeMind, Freeplane' },
  { id: 'anki', label: 'Anki 카드 (.txt)', hint: '질문 :: 답, ==빈칸== 카드를 Anki 로' },
  { id: 'svg', label: '이미지 SVG', hint: '확대해도 선명한 그림' },
  { id: 'png', label: '이미지 PNG', hint: '2배 해상도' },
  { id: 'pdf', label: 'PDF 로 인쇄', hint: '인쇄 창에서 "PDF 로 저장"' },
];

/** 파일 이름으로 쓸 수 없는 글자를 걷어 낸다 */
export function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 80) || '맵';
}

export function download(data: Blob | string, filename: string, type = 'application/octet-stream') {
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function printSvg(svg: string, title: string) {
  const w = window.open('', '_blank');
  if (!w) throw new Error('팝업이 차단되었습니다. 이 사이트의 팝업을 허용해 주세요');
  w.document.write(
    `<!doctype html><title>${title.replace(/</g, '&lt;')}</title><style>@page{size:auto;margin:10mm}html,body{margin:0}svg{width:100%;height:auto}</style>${svg}`,
  );
  w.document.close();
  w.onload = () => w.print();
}

export async function exportMap(doc: MapDoc, format: ExportFormat): Promise<void> {
  const title = safeName(String(doc.meta.title ?? doc.root.text.split('\n')[0]));
  switch (format) {
    case 'md':
      return download(serializeMap(doc), `${title}.mm.md`, 'text/markdown');
    case 'opml':
      return download(toOpml(doc), `${title}.opml`, 'text/x-opml');
    case 'freemind':
      return download(toFreeMind(doc), `${title}.mm`, 'application/xml');
    case 'xmind': {
      const files: Record<string, Uint8Array> = {};
      for (const [name, text] of Object.entries(toXMindFiles(doc))) files[name] = strToU8(text);
      return download(new Blob([zipSync(files) as Uint8Array<ArrayBuffer>]), `${title}.xmind`);
    }
    case 'anki': {
      const cards = buildCards(doc, { includeChildren: false });
      if (!cards.length) throw new Error('카드가 없습니다. "질문 :: 답" 이나 ==빈칸== 을 먼저 써 주세요');
      return download(toAnkiCsv(cards), `${title}-anki.txt`, 'text/plain');
    }
    case 'svg':
      return download(mapToSvg(doc).svg, `${title}.svg`, 'image/svg+xml');
    case 'png': {
      const { svg, width, height } = mapToSvg(doc);
      return download(await svgToPng(svg, width, height), `${title}.png`);
    }
    case 'pdf':
      return printSvg(mapToSvg(doc).svg, title);
  }
}

const plainResult = (doc: MapDoc): ImportedMarkdown => ({ doc, mode: 'outline', warnings: 0 });

/** 파일 하나를 맵(들)로 바꾼다. 형식은 확장자로 판단하되, .md/.txt 는 내용을 보고 맵 형식인지 판별한다. */
export async function parseImportDetailed(file: File): Promise<ImportedMarkdown[]> {
  const name = file.name.toLowerCase();
  const stem = file.name.replace(/\.(mm\.md|md|markdown|txt|opml|xml|xmind|mm)$/i, '');
  if (name.endsWith('.xmind')) {
    const zip = unzipSync(new Uint8Array(await file.arrayBuffer()));
    if (zip['content.json']) return fromXMindContent(strFromU8(zip['content.json'])).map(plainResult);
    if (zip['content.xml']) {
      throw new Error('XMind 8 이전의 옛 형식(content.xml)은 읽지 못합니다. XMind 에서 최신 형식으로 저장하거나 OPML 로 내보내 주세요');
    }
    throw new Error('XMind 파일 안에서 맵 내용을 찾지 못했습니다');
  }
  const text = await file.text();
  if (name.endsWith('.opml') || (name.endsWith('.xml') && /<opml[\s>]/i.test(text))) {
    const d = fromOpml(text);
    if (!d.meta.title) d.meta.title = stem;
    return [plainResult(d)];
  }
  if (name.endsWith('.md') || name.endsWith('.markdown') || name.endsWith('.txt')) {
    // .mm.md 는 항상 맵 형식. 그 밖의 .md/.txt 는 AI 가 만든 맵 형식인지 내용을 보고 판별한다
    return [importMarkdown(stripOuterFence(text), stem, name.endsWith('.mm.md'))];
  }
  throw new Error('지원하지 않는 형식입니다. .xmind, .opml, .md, .txt 파일을 고르세요');
}

export async function parseImport(file: File): Promise<MapDoc[]> {
  return (await parseImportDetailed(file)).map((r) => r.doc);
}

/** 붙여넣은 마크다운 글을 맵으로 바꾼다 (AI 채팅에서 복사한 글). 코드블록 울타리가 같이 복사됐으면 걷어 낸다. */
export function parseImportText(raw: string, titleHint = '붙여넣은 맵'): ImportedMarkdown {
  const text = stripOuterFence(raw).trim();
  if (!text) throw new Error('붙여넣은 내용이 없습니다');
  return importMarkdown(text, titleHint);
}

/** ```` 또는 ``` 로 통째로 감싼 글이면 안쪽만 꺼낸다 */
export function stripOuterFence(raw: string): string {
  const m = /^\s*(`{3,})[^\n`]*\r?\n([\s\S]*?)\r?\n\1\s*$/.exec(raw);
  return m ? m[2] : raw;
}

/** 가져온 맵을 dir 폴더에 새 맵으로 만든다. 같은 이름이 있으면 번호를 붙인다. 만들어진 경로를 돌려준다. */
export async function saveImported(dir: string, doc: MapDoc): Promise<string> {
  const base = safeName(String(doc.meta.title ?? doc.root.text.split('\n')[0]));
  for (let n = 1; n < 100; n++) {
    const name = n === 1 ? base : `${base} (${n})`;
    try {
      const { path } = await api.createMap(dir, name);
      const { hash } = await api.read(path);
      await api.write(path, serializeMap({ ...doc, meta: { ...doc.meta, title: name } }), hash);
      return path;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) continue;
      throw e;
    }
  }
  throw new Error('같은 이름의 맵이 너무 많습니다');
}
