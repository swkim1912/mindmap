/** 맵 파일 검사: npm run lint:map -- <파일...> */
import fs from 'node:fs';
import path from 'node:path';
import { parseMap } from '@mindmap/core';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('사용법: npm run lint:map -- <파일.mm.md> [...]');
  process.exit(2);
}
let failed = false;
for (const f of files) {
  const abs = path.resolve(process.env.INIT_CWD ?? process.cwd(), f);
  const { warnings, normalized } = parseMap(fs.readFileSync(abs, 'utf8'));
  if (!warnings.length) {
    console.log(`✓ ${f}${normalized ? ' (ID 없는 노드는 앱이 열 때 자동 부여)' : ''}`);
    continue;
  }
  failed = true;
  console.log(`✗ ${f}`);
  for (const w of warnings) console.log(`  ${w.line}행: ${w.message}`);
}
process.exit(failed ? 1 : 0);
