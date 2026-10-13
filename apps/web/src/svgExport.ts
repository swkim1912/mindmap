import { getLayout, plainLine, type MapDoc, type MapNode } from '@mindmap/core';
import { branchColor, resolveColor } from './colors';
import { computeLayout, edgePath, estimateSize, type Box } from './layout';

/** 그림으로 내보낼 때 쓰는 단순한 글자 모양 (Markdown 기호는 걷어 낸다) */
function plain(text: string): string[] {
  return text
    .split('\n')
    .map((l) =>
      plainLine(l)
        .replace(/==([^=]+)==/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\$([^$]+)\$/g, '$1'),
    )
    .filter((l, i, a) => l || a.length === 1);
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const FONT = "'Pretendard','Apple SD Gothic Neo','Malgun Gothic',system-ui,sans-serif";
const fontSize = (d: number) => (d === 0 ? 22 : d === 1 ? 16 : 14);

/** 맵을 SVG 문자열로 그린다 (접힌 노드는 접힌 채로, 메모는 제외) */
export function mapToSvg(doc: MapDoc): { svg: string; width: number; height: number } {
  const kind = getLayout(doc);
  const layout = computeLayout(doc.root, kind, (n: MapNode, d) => estimateSize({ ...n, text: plain(n.text).join('\n') }, d));
  const pad = 32;
  const { minX, minY, maxX, maxY } = layout.bounds;
  const width = Math.ceil(maxX - minX + pad * 2);
  const height = Math.ceil(maxY - minY + pad * 2);
  const parts: string[] = [];

  for (const b of layout.order) {
    if (!b.parentId) continue;
    const p = layout.boxes.get(b.parentId);
    if (!p) continue;
    const color = resolveColor(b.node.attrs.color) ?? branchColor(b.branch === 0 && b.depth === 0 ? -1 : b.branch);
    parts.push(`<path d="${edgePath(p, b, kind)}" fill="none" stroke="${color.startsWith('var') ? '#9aa3ad' : color}" stroke-width="${b.depth <= 1 ? 2.2 : 1.6}"/>`);
  }
  for (const b of layout.order) parts.push(drawNode(b));

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${minX - pad} ${minY - pad} ${width} ${height}" font-family="${FONT}">` +
    `<rect x="${minX - pad}" y="${minY - pad}" width="${width}" height="${height}" fill="#ffffff"/>${parts.join('')}</svg>`;
  return { svg, width, height };
}

function drawNode(b: Box): string {
  const lines = plain(b.node.text);
  const fs = fontSize(b.depth);
  const accent = resolveColor(b.node.attrs.color) ?? branchColor(b.branch);
  const color = accent.startsWith('var') ? '#9aa3ad' : accent;
  const cx = b.x + b.w / 2;
  const textAt = (fill: string, weight = 400) =>
    lines
      .map((l, i) => `<text x="${cx}" y="${b.y + 7 + fs * 1.5 * (i + 0.5) + fs * 0.35}" font-size="${fs}" font-weight="${weight}" fill="${fill}" text-anchor="middle">${xml(l)}</text>`)
      .join('');
  if (b.depth === 0) {
    return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="10" fill="#1f2937"/>${textAt('#ffffff', 700)}`;
  }
  if (b.depth === 1) {
    return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="8" fill="#ffffff" stroke="${color}" stroke-width="2"/>${textAt('#1f2328', 600)}`;
  }
  return `${textAt('#1f2328')}<line x1="${b.x}" y1="${b.y + b.h - 1}" x2="${b.x + b.w}" y2="${b.y + b.h - 1}" stroke="${color}" stroke-width="1.6"/>`;
}

/** SVG 를 PNG(2배 해상도)로 바꾼다. 외부 자원이 없는 SVG 라 캔버스가 오염되지 않는다. */
export function svgToPng(svg: string, width: number, height: number, scale = 2): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = Math.min(8000, Math.round(width * scale));
      c.height = Math.min(8000, Math.round(height * scale));
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0, c.width, c.height);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG 를 만들지 못했습니다'))), 'image/png');
    };
    img.onerror = () => reject(new Error('그림을 그리지 못했습니다'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}
