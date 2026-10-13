import { useEffect, useState } from 'react';
import { api, getBackend, type SyncInfo } from '../api';
import { cloudBackend } from '../cloud/CloudGate';

const LABEL = { idle: '동기화됨', syncing: '동기화 중…', error: '동기화 오류', off: '동기화 꺼짐' } as const;

/** 클라우드 동기화 상태. 누르면 지금 동기화한다. PC 에서 설정이 없으면 아무것도 보이지 않는다. */
export function SyncBadge() {
  const [info, setInfo] = useState<SyncInfo | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = () => api.syncInfo().then((i) => alive && setInfo(i)).catch(() => {});
    void poll();
    const unsub = cloudBackend?.onSyncChange((i) => alive && setInfo(i));
    const t = setInterval(poll, 10_000);
    return () => {
      alive = false;
      unsub?.();
      clearInterval(t);
    };
  }, []);

  if (!info?.enabled) return null;
  const state = info.state ?? 'idle';
  const online = typeof navigator === 'undefined' || navigator.onLine;
  const label = !online && state !== 'syncing' ? '오프라인' : LABEL[state];
  const title = [info.error, info.lastSync ? `마지막 동기화: ${new Date(info.lastSync).toLocaleTimeString()}` : '', info.conflicts ? `충돌 사본 ${info.conflicts}개 생김` : '']
    .filter(Boolean)
    .join('\n');
  return (
    <button className={`sync-badge ${!online ? 'offline' : state}`} title={title || '지금 동기화'} onClick={() => void api.syncNow().then(setInfo).catch(() => {})}>
      ☁ {label}
    </button>
  );
}

export function SignOutButton() {
  const b = getBackend();
  if (!b.signOut) return null;
  return (
    <button className="signout" onClick={() => confirm('로그아웃할까요? (이 기기에 저장된 오프라인 사본은 유지됩니다)') && void b.signOut!()}>
      로그아웃
    </button>
  );
}
