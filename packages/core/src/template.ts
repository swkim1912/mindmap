import type { LayoutKind } from './model';
import { randomId } from './id';

export function newMapSource(title: string, layout: LayoutKind = 'mindmap'): string {
  return `---
id: map_${randomId(6)}
title: ${JSON.stringify(title)}
layout: ${layout}
---

# ${title.replace(/\s+/g, ' ').trim() || '중심 주제'} ^root
`;
}
