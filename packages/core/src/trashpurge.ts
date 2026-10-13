/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 휴지통 내용을 클라우드(Supabase)에서 비운다. 삭제 표시 행은 남기고(다른 기기가 삭제를 알도록) 내용만 지운다.
 * 이미지 객체는 같은 내용을 쓰는 다른 파일이 없을 때만 지운다 (이름이 내용 해시라 파일끼리 공유될 수 있음).
 */
export async function purgeTrashRows(client: any, bucket: string, scope: (q: any) => any): Promise<void> {
  const sel = scope(client.from('vault_files').select('path,blob').eq('deleted', true).not('trash_id', 'is', null));
  const { data, error } = await sel;
  if (error) throw new Error(`휴지통 정리 실패: ${error.message}`);
  if (!data?.length) return;
  const blobs = [...new Set((data as { blob: string | null }[]).map((r) => r.blob).filter((b): b is string => !!b))];
  const upd = scope(
    client.from('vault_files').update({ content: null, blob: null, trash_id: null }).eq('deleted', true).not('trash_id', 'is', null),
  );
  const { error: e2 } = await upd;
  if (e2) throw new Error(`휴지통 정리 실패: ${e2.message}`);
  for (const name of blobs) {
    const { count } = await client.from('vault_files').select('path', { count: 'exact', head: true }).eq('blob', name);
    if (!count) await client.storage.from(bucket).remove([name]);
  }
}
