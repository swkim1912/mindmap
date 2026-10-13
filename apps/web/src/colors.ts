/** 1단계 가지 색상 (XMind처럼 가지마다 다른 색) */
const BRANCH = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#f08c00', '#0c8599', '#d6336c', '#5c7cfa'];

export function branchColor(branch: number): string {
  return branch < 0 ? 'var(--root-edge)' : BRANCH[branch % BRANCH.length];
}

export const NAMED_COLORS: Record<string, string> = {
  red: '#e03131',
  orange: '#f76707',
  yellow: '#f2b705',
  green: '#2f9e44',
  blue: '#1c7ed6',
  purple: '#9c36b5',
  gray: '#868e96',
};

export function resolveColor(v: string | true | undefined): string | null {
  if (typeof v !== 'string') return null;
  if (NAMED_COLORS[v]) return NAMED_COLORS[v];
  return /^#[0-9a-f]{3,8}$/i.test(v) ? v : null;
}
