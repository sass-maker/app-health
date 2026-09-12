import { useEffect, useState } from 'react';
export type PublicState<T> =
  | { kind: 'loading' }
  | { kind: 'ready'; data: T }
  | { kind: 'unavailable'; reason: 'link' | 'temporary' };

/** Public access is revalidated each read. Aborted or superseded reads cannot restore old data. */
export function usePublicAnalytics<T>(token: string | null, parse: (body: unknown) => T | null) {
  const [state, setState] = useState<PublicState<T>>({ kind: 'loading' });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    setState(token ? { kind: 'loading' } : { kind: 'unavailable', reason: 'link' });
    if (!token) return;
    return pollPublic(token, parse, setState);
  }, [token, parse, revision]);
  return { state, retry: () => setRevision((value) => value + 1) };
}
function pollPublic<T>(
  token: string,
  parse: (body: unknown) => T | null,
  publish: (state: PublicState<T>) => void,
) {
  let cancelled = false;
  let blocked = false;
  let active: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let delay = 10000;
  const visible = () => document.visibilityState !== 'hidden';
  const schedule = () => {
    clearTimeout(timer);
    if (!cancelled && !blocked && visible()) timer = setTimeout(() => void load(), delay);
  };
  function unavailable() {
    publish({ kind: 'unavailable', reason: 'temporary' });
    delay = Math.min(60000, delay * 2);
    schedule();
  }
  const canLoad = () => !cancelled && !blocked && visible() && !active;
  async function load() {
    if (!canLoad()) return;
    const controller = new AbortController();
    active = controller;
    timeout = setTimeout(() => {
      if (active !== controller) return;
      active = null;
      controller.abort();
      unavailable();
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
        publish({ kind: 'unavailable', reason: 'link' });
        return;
      }
      if (!response.ok) throw new Error('Unavailable');
      const body = await response.json();
      if (cancelled || active !== controller) return;
      const data = parse(body);
      if (!data) throw new Error('Invalid response');
      publish({ kind: 'ready', data });
      delay = 10000;
      schedule();
    } catch {
      if (!cancelled && active === controller) unavailable();
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
    publish({ kind: 'loading' });
    if (visible()) void load();
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
