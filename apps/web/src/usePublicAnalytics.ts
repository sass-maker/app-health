import { useEffect, useRef, useState } from 'react';

export type PublicState<T> =
  | { kind: 'loading' }
  | { kind: 'ready'; data: T; refreshing?: boolean; stale?: boolean }
  | { kind: 'unavailable'; reason: 'link' | 'temporary' };

type ScopedState<T> = { scope: string | null; state: PublicState<T> };

/** Public access is revalidated without blanking an already loaded report. */
export function usePublicAnalytics<T>(token: string | null, parse: (body: unknown) => T | null) {
  const [scoped, setScoped] = useState<ScopedState<T>>({
    scope: null,
    state: { kind: 'loading' },
  });
  const scopedRef = useRef(scoped);
  scopedRef.current = scoped;
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!token) {
      setScoped({ scope: null, state: { kind: 'unavailable', reason: 'link' } });
      return;
    }
    const current = scopedRef.current;
    const existing =
      current.scope === token && current.state.kind === 'ready' ? current.state : null;
    setScoped({
      scope: token,
      state: existing ? { ...existing, refreshing: true } : { kind: 'loading' },
    });
    return pollPublic(token, parse, (state) => setScoped({ scope: token, state }), existing);
  }, [token, parse, revision]);

  // Effects run after paint. Scope the returned snapshot during that gap so a
  // new token can never render the previous token's report for one frame.
  const state =
    scoped.scope === token
      ? scoped.state
      : token
        ? { kind: 'loading' as const }
        : { kind: 'unavailable' as const, reason: 'link' as const };
  return { state, retry: () => setRevision((value) => value + 1) };
}

function pollPublic<T>(
  token: string,
  parse: (body: unknown) => T | null,
  publish: (state: PublicState<T>) => void,
  existing: Extract<PublicState<T>, { kind: 'ready' }> | null,
) {
  let cancelled = false;
  let blocked = false;
  let active: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let delay = 10000;
  let current = existing?.data;
  let currentStale = existing?.stale === true;
  const visible = () => document.visibilityState !== 'hidden';
  const schedule = () => {
    clearTimeout(timer);
    if (!cancelled && !blocked && visible()) timer = setTimeout(() => void load(), delay);
  };
  const publishTemporaryFailure = () => {
    if (current !== undefined) {
      currentStale = true;
      publish({ kind: 'ready', data: current, stale: true, refreshing: false });
    } else publish({ kind: 'unavailable', reason: 'temporary' });
    delay = Math.min(60000, delay * 2);
    schedule();
  };
  const canLoad = () => !cancelled && !blocked && visible() && !active;
  async function load() {
    if (!canLoad()) return;
    if (current !== undefined)
      publish({ kind: 'ready', data: current, refreshing: true, stale: currentStale });
    const controller = new AbortController();
    active = controller;
    timeout = setTimeout(() => {
      if (active !== controller) return;
      active = null;
      controller.abort();
      publishTemporaryFailure();
    }, 10000);
    try {
      const response = await fetch('/v1/shared/analytics', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (cancelled || active !== controller) return;
      if ([401, 403, 404, 410].includes(response.status)) {
        blocked = true;
        current = undefined;
        publish({ kind: 'unavailable', reason: 'link' });
        return;
      }
      if (!response.ok) throw new Error('Unavailable');
      const body = await response.json();
      if (cancelled || active !== controller) return;
      const data = parse(body);
      if (!data) throw new Error('Invalid response');
      current = data;
      currentStale = false;
      publish({ kind: 'ready', data, refreshing: false, stale: false });
      delay = 10000;
      schedule();
    } catch {
      if (!cancelled && active === controller) publishTemporaryFailure();
    } finally {
      if (active === controller) {
        clearTimeout(timeout);
        active = null;
      }
    }
  }
  function visibilityChange() {
    clearTimeout(timer);
    clearTimeout(timeout);
    active?.abort();
    active = null;
    if (cancelled || blocked) return;
    if (visible()) void load();
    else if (current !== undefined) {
      currentStale = true;
      publish({ kind: 'ready', data: current, refreshing: false, stale: true });
    }
  }
  document.addEventListener('visibilitychange', visibilityChange);
  void load();
  return () => {
    cancelled = true;
    clearTimeout(timer);
    clearTimeout(timeout);
    active?.abort();
    active = null;
    document.removeEventListener('visibilitychange', visibilityChange);
  };
}
