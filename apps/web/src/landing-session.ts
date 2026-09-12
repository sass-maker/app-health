type SessionProbe = {
  user?: { emailVerified?: boolean } | null;
  session?: unknown;
};

export interface LandingSessionOptions {
  fetchImpl?: typeof fetch;
  navigate?: (path: string) => void;
}

export async function redirectSignedInLanding(
  fetchImpl: typeof fetch = fetch,
  navigate: (path: string) => void = (path) => window.location.replace(path),
  signal?: AbortSignal,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  try {
    if (controller.signal.aborted) return false;
    const response = await fetchImpl('/v1/auth/get-session', {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const body = (await response.json()) as SessionProbe;
    if (controller.signal.aborted || body.user?.emailVerified !== true) return false;
    if (
      typeof body.session !== 'object' ||
      body.session === null ||
      !('id' in body.session) ||
      typeof body.session.id !== 'string' ||
      body.session.id.length === 0
    )
      return false;
    navigate('/app');
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
