export type LayoutKind = 'mindmap' | 'logic-right';

export const LAYOUTS: LayoutKind[] = ['mindmap', 'logic-right'];

/** 노드 속성. `{color=red tags=시험,중요 collapsed}` → { color: 'red', tags: '시험,중요', collapsed: true } */
export type Attrs = Record<string, string | true>;

export interface MapNode {
  id: string;
  /** 노드 본문 (인라인 Markdown). 여러 줄 가능. */
  text: string;
  attrs: Attrs;
  /** 포스트잇 메모 (Markdown). 없으면 null. */
  note: string | null;
  children: MapNode[];
}

export interface MapDoc {
  /** frontmatter (id, title, layout, theme, ...) */
  meta: Record<string, unknown>;
  /** frontmatter가 YAML로 파싱되지 않을 때 원문을 보존한다 */
  rawFrontmatter: string | null;
  root: MapNode;
  /** 맵 구조로 해석되지 않은 줄. 손실 없이 보존하기 위해 그대로 둔다. */
  extra: string[];
}

export interface ParseWarning {
  line: number;
  message: string;
}

export interface ParseResult {
  doc: MapDoc;
  warnings: ParseWarning[];
  /** 파싱 중 ID를 새로 부여하는 등 원문과 달라진 부분이 있음 */
  normalized: boolean;
}

export function getLayout(doc: MapDoc): LayoutKind {
  const l = doc.meta.layout;
  return LAYOUTS.includes(l as LayoutKind) ? (l as LayoutKind) : 'mindmap';
}

export function getTags(node: MapNode): string[] {
  const t = node.attrs.tags;
  if (typeof t !== 'string') return [];
  return t.split(',').map((s) => s.trim()).filter(Boolean);
}

export function isCollapsed(node: MapNode): boolean {
  return node.attrs.collapsed === true || node.attrs.collapsed === 'true';
}
