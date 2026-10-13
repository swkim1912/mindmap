import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { setBackend } from '../api';
import { createCloudBackend, type CloudBackend } from './cloudBackend';

const URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const KEY = import.meta.env.VITE_SUPABASE_KEY as string | undefined;
const OWNER_KEY = 'mm-owner';

type Phase = { t: 'loading' } | { t: 'login'; error?: string } | { t: 'ready'; backend: CloudBackend } | { t: 'fatal'; error: string };

export let cloudBackend: CloudBackend | null = null;

/** 모바일(클라우드) 모드: 로그인한 뒤 Supabase 와 동기화하는 백엔드를 연결하고 앱을 보여 준다 */
export function CloudGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>({ t: 'loading' });
  const clientRef = useRef<SupabaseClient | null>(null);

  useEffect(() => {
    if (!URL || !KEY) {
      setPhase({ t: 'fatal', error: 'Supabase 설정(VITE_SUPABASE_URL, VITE_SUPABASE_KEY)이 빌드에 없습니다.' });
      return;
    }
    // StrictMode 는 effect 를 두 번 실행하므로, 실행마다 따로 정리할 수 있게 지역 변수로 관리한다
    let cancelled = false;
    let backend: CloudBackend | null = null;
    let opening = false;
    const client = createClient(URL, KEY, { auth: { persistSession: true, autoRefreshToken: true } });
    clientRef.current = client;

    const open = async (owner: string) => {
      if (backend || opening || cancelled) return;
      opening = true;
      try {
        localStorage.setItem(OWNER_KEY, owner);
      } catch {
        /* 저장소를 못 쓰면 오프라인 시작만 안 됨 */
      }
      try {
        const b = await createCloudBackend(client, owner);
        if (cancelled) return b.dispose();
        backend = b;
        cloudBackend = b;
        setBackend(b);
        setPhase({ t: 'ready', backend: b });
      } catch (e) {
        if (!cancelled) setPhase({ t: 'fatal', error: `저장소를 열 수 없습니다: ${(e as Error).message}` });
      } finally {
        opening = false;
      }
    };
    const close = () => {
      backend?.dispose();
      backend = null;
      cloudBackend = null;
    };

    void (async () => {
      const { data } = await client.auth.getSession().catch(() => ({ data: { session: null } }));
      if (cancelled) return;
      if (data.session) return open(data.session.user.id);
      // 오프라인이면 마지막으로 로그인했던 계정의 캐시를 그대로 연다
      let last: string | null = null;
      try {
        last = localStorage.getItem(OWNER_KEY);
      } catch {
        /* 무시 */
      }
      if (last && !navigator.onLine) return open(last);
      setPhase({ t: 'login' });
    })();

    const { data: sub } = client.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' && session) void open(session.user.id);
      if (event === 'SIGNED_OUT') {
        close();
        setPhase({ t: 'login' });
      }
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
      close();
    };
  }, []);

  if (phase.t === 'ready') return <>{children}</>;
  if (phase.t === 'loading') return <div className="gate"><p className="muted">불러오는 중…</p></div>;
  if (phase.t === 'fatal') return <div className="gate"><p className="gate-error">{phase.error}</p></div>;
  return <Login client={clientRef.current!} error={phase.error} />;
}

function Login({ client, error }: { client: SupabaseClient; error?: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(error ?? '');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg('');
    const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) setMsg(error.message === 'Invalid login credentials' ? '이메일 또는 비밀번호가 맞지 않습니다' : error.message);
  };

  return (
    <div className="gate">
      <form className="login" onSubmit={submit}>
        <h1>마인드맵</h1>
        <label>
          이메일
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          비밀번호
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {msg && <p className="gate-error">{msg}</p>}
        <button type="submit" disabled={busy}>
          {busy ? '로그인 중…' : '로그인'}
        </button>
      </form>
    </div>
  );
}
