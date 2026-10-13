import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { purgeTrashRows, type PutRow, type Remote, type RemoteRow } from '@mindmap/core';

const BUCKET = 'vault-assets';
const PAGE = 1000;

export interface SupabaseConfig {
  url: string;
  key: string;
  email: string;
  password: string;
}

/** 환경 변수에서 설정을 읽는다. 하나라도 없으면 null (동기화 꺼짐) */
export function readSupabaseConfig(env: NodeJS.ProcessEnv = process.env): SupabaseConfig | null {
  const url = env.MINDMAP_SUPABASE_URL;
  const key = env.MINDMAP_SUPABASE_KEY;
  const email = env.MINDMAP_SYNC_EMAIL;
  const password = env.MINDMAP_SYNC_PASSWORD;
  return url && key && email && password ? { url, key, email, password } : null;
}

export class SupabaseRemote implements Remote {
  private client: SupabaseClient;
  private owner: string | null = null;
  private signingIn: Promise<string> | null = null;

  constructor(private cfg: SupabaseConfig) {
    this.client = createClient(cfg.url, cfg.key, { auth: { persistSession: false, autoRefreshToken: true } });
  }

  /** 로그인하고 사용자 ID 를 돌려준다 (동시에 여러 번 불려도 한 번만 로그인) */
  private async ownerId(): Promise<string> {
    if (this.owner) return this.owner;
    this.signingIn ??= (async () => {
      const { data, error } = await this.client.auth.signInWithPassword({ email: this.cfg.email, password: this.cfg.password });
      if (error || !data.user) {
        this.signingIn = null;
        throw new Error(`Supabase 로그인 실패: ${error?.message ?? '알 수 없는 오류'}`);
      }
      return (this.owner = data.user.id);
    })();
    return this.signingIn;
  }

  async listSince(cursor: string | null): Promise<RemoteRow[]> {
    await this.ownerId();
    const out: RemoteRow[] = [];
    let from = 0;
    for (;;) {
      let q = this.client.from('vault_files').select('path,content,blob,hash,deleted,updated_at,trash_id').order('updated_at').order('path');
      if (cursor) q = q.gt('updated_at', cursor);
      const { data, error } = await q.range(from, from + PAGE - 1);
      if (error) throw new Error(`목록을 받지 못했습니다: ${error.message}`);
      out.push(...(data as RemoteRow[]));
      if (data.length < PAGE) return out;
      from += PAGE;
    }
  }

  async put(row: PutRow): Promise<void> {
    await this.ownerId();
    const { error } = await this.client
      .from('vault_files')
      .upsert({ ...row, device: 'pc' }, { onConflict: 'owner,path' });
    if (error) throw new Error(`${row.path} 업로드 실패: ${error.message}`);
  }

  /** 내용 해시로 이름을 정해 같은 이미지를 두 번 올리지 않는다 */
  blobName(hash: string, ext: string): string {
    if (!this.owner) throw new Error('로그인 전입니다');
    return `${this.owner}/${hash}${ext.toLowerCase()}`;
  }

  async uploadBlob(name: string, bytes: Uint8Array): Promise<void> {
    await this.ownerId();
    const { error } = await this.client.storage.from(BUCKET).upload(name, bytes, { upsert: true, contentType: 'application/octet-stream' });
    if (error) throw new Error(`이미지 업로드 실패: ${error.message}`);
  }

  async downloadBlob(name: string): Promise<Uint8Array> {
    await this.ownerId();
    const { data, error } = await this.client.storage.from(BUCKET).download(name);
    if (error || !data) throw new Error(`이미지 다운로드 실패: ${error?.message ?? name}`);
    return new Uint8Array(await data.arrayBuffer());
  }

  async purgeTrash(ids: string[]): Promise<void> {
    await this.ownerId();
    if (ids.length) await purgeTrashRows(this.client, BUCKET, (q) => q.in('trash_id', ids));
  }

  async purgeExpiredTrash(cutoffId: string): Promise<void> {
    await this.ownerId();
    await purgeTrashRows(this.client, BUCKET, (q) => q.lt('trash_id', cutoffId));
  }

  /** 다른 기기(모바일)에서 바뀌면 callback 을 부른다. 해제 함수를 돌려준다. */
  async subscribe(callback: () => void): Promise<() => void> {
    await this.ownerId();
    const channel = this.client
      .channel('vault-files')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'vault_files' }, callback)
      .subscribe();
    return () => void this.client.removeChannel(channel);
  }
}
