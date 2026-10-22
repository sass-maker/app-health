import { useEffect, useRef, useState } from 'react';
import { ListAppsResponseV1 } from '@app-health/contracts';

async function readAccountBootstrap(): Promise<{
  google: boolean;
  listed: ListAppsResponseV1 | null;
}> {
  const config = await fetch('/v1/account/config');
  if (!config.ok) throw new Error('account configuration unavailable');
  const options = (await config.json()) as { google?: unknown } | null;
  if (typeof options?.google !== 'boolean') throw new Error('invalid account configuration');
  if (!options.google) return { google: false, listed: null };

  const response = await fetch('/v1/apps');
  // An absent/expired session should offer sign-in; an unavailable service should not.
  if (response.status === 401 || response.status === 403) return { google: true, listed: null };
  if (!response.ok) throw new Error('workspace session unavailable');
  return { google: true, listed: ListAppsResponseV1.parse(await response.json()) };
}

export function useAccountBootstrap() {
  const [result, setResult] = useState<Awaited<ReturnType<typeof readAccountBootstrap>> | null>(
    null,
  );
  const [pending, setPending] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const request = useRef<ReturnType<typeof readAccountBootstrap> | null>(null);

  useEffect(() => {
    let cancelled = false;
    request.current ??= readAccountBootstrap();
    void request.current
      .then((value) => {
        if (cancelled) return;
        setResult(value);
        setPending(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError('Workspace sign-in could not be checked. Please try again.');
        setPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  function retry(): void {
    request.current = null;
    setError('');
    setPending(true);
    setAttempt((value) => value + 1);
  }
  return { result, pending, error, retry };
}
