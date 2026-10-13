import fs from 'node:fs/promises';
import path from 'node:path';
import { applyResult, type StudyRecord } from '@mindmap/core';
import { HttpError, atomicWrite } from './vault';

/** 맵 경로 → 카드 ID → 기록 */
type Data = Record<string, Record<string, StudyRecord>>;

export interface StudyResult {
  id: string;
  known: boolean;
}

const MAX_RESULTS = 500;

/**
 * 복습 기록 (.mindmap/study.json). 맵 파일은 건드리지 않는다.
 * 모든 읽기/쓰기는 한 줄로 세워 동시에 파일을 쓰지 않게 한다.
 */
export class StudyStore {
  private data: Data | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private file: string) {}

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    this.queue = result.catch(() => {});
    return result;
  }

  private async load(): Promise<Data> {
    if (this.data) return this.data;
    let raw: string;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      return (this.data = {});
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('객체가 아님');
      return (this.data = parsed as Data);
    } catch (e) {
      // 깨진 파일은 지우지 않고 옆에 보관한 뒤 새로 시작한다
      const backup = `${this.file}.corrupt-${Date.now()}`;
      await fs.rename(this.file, backup).catch(() => {});
      console.error(`[study] 학습 기록 파일이 깨져 ${path.basename(backup)} 로 옮겼습니다:`, (e as Error).message);
      return (this.data = {});
    }
  }

  private async save(data: Data) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await atomicWrite(this.file, JSON.stringify(data, null, 1));
  }

  /** 파일이 밖에서(동기화 등) 바뀌었으니 다음 읽기 때 다시 불러온다 */
  invalidate(): Promise<void> {
    return this.run(async () => {
      this.data = null;
    });
  }

  get(mapPath: string): Promise<Record<string, StudyRecord>> {
    return this.run(async () => (await this.load())[mapPath] ?? {});
  }

  record(mapPath: string, results: StudyResult[]): Promise<void> {
    if (!Array.isArray(results) || results.length > MAX_RESULTS) throw new HttpError(400, '결과 목록이 올바르지 않습니다');
    for (const r of results) {
      if (!r || typeof r.id !== 'string' || !r.id || r.id.length > 200 || typeof r.known !== 'boolean') {
        throw new HttpError(400, '결과 형식이 올바르지 않습니다');
      }
    }
    return this.run(async () => {
      const data = await this.load();
      const map = (data[mapPath] ??= {});
      const at = new Date().toISOString();
      for (const r of results) map[r.id] = applyResult(map[r.id], r.known, at);
      await this.save(data);
    });
  }

  /** 맵 파일을 옮기거나 이름을 바꿨을 때 기록도 따라가게 한다 (옛 경로 → 새 경로) */
  moveMaps(moved: Map<string, string>): Promise<void> {
    return this.run(async () => {
      const data = await this.load();
      let changed = false;
      for (const [from, to] of moved) {
        if (from !== to && data[from]) {
          data[to] = { ...(data[to] ?? {}), ...data[from] };
          delete data[from];
          changed = true;
        }
      }
      if (changed) await this.save(data);
    });
  }
}
