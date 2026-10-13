import fs from 'node:fs/promises';
import path from 'node:path';
import { zipSync } from 'fflate';
import type { Vault } from './vault';

/** 백업에서 뺄 내부 폴더: 버전 기록·휴지통은 크고, 동기화 상태는 기기마다 다르다 */
const SKIP_INTERNAL = new Set(['history', 'trash', 'sync-base', 'sync.json']);

/** Vault 전체(맵·페이지·이미지·복습 기록)를 zip 하나로 만든다 */
export async function buildBackup(vault: Vault): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const walk = async (abs: string) => {
    for (const e of await fs.readdir(abs, { withFileTypes: true })) {
      const p = path.join(abs, e.name);
      const rel = vault.toRel(p);
      if (abs === vault.internalDir) {
        if (SKIP_INTERNAL.has(e.name) || e.name.includes('.corrupt-') || e.name.endsWith('.tmp')) continue;
      } else if (e.name.startsWith('.') && p !== vault.internalDir) continue; // 임시 파일 등
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) files[rel] = new Uint8Array(await fs.readFile(p));
    }
  };
  await walk(vault.root);
  return zipSync(files, { level: 6 });
}
