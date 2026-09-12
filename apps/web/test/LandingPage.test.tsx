import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LandingPage } from '../src/LandingPage.js';
import { redirectSignedInLanding } from '../src/landing-session.js';

beforeEach(() => {
  document.documentElement.classList.add('dark');
  document.documentElement.dataset.theme = 'dark';
  vi.stubGlobal('localStorage', {
    getItem: vi.fn(),
    setItem: vi.fn(),
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(null, { status: 503 })),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.documentElement.className = '';
  delete document.documentElement.dataset.theme;
});

it('introduces analytics and event exploration to product people with honest proof', () => {
  render(<LandingPage />);
  expect(screen.getByRole('heading', { name: /See what people do/ })).toBeTruthy();
  expect(screen.getByText('For people shaping digital products')).toBeTruthy();
  expect(screen.getByLabelText('Illustrative web analytics preview')).toBeTruthy();
  expect(screen.queryByText(/funnels/i)).toBeNull();
  expect(screen.getByRole('contentinfo')).toHaveTextContent('A Fleet product');
  expect(
    screen.getAllByRole('link', { name: /Open App Health|Open dashboard/ }).length,
  ).toBeGreaterThan(0);
});

it('offers complete theme control from the landing navigation', () => {
  render(<LandingPage />);
  fireEvent.click(screen.getByRole('button', { name: 'Switch to light mode' }));
  expect(document.documentElement).not.toHaveClass('dark');
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(localStorage.setItem).toHaveBeenCalledWith('app-health-theme', 'light');
});

it('redirects only a verified signed-in session', async () => {
  const navigate = vi.fn();
  const fetch = vi.fn(async () =>
    Response.json({ user: { emailVerified: true }, session: { id: 'session' } }),
  );
  await expect(redirectSignedInLanding(fetch, navigate)).resolves.toBe(true);
  expect(navigate).toHaveBeenCalledWith('/app');
});

it('redirects once under StrictMode and ignores an aborted response', async () => {
  const navigate = vi.fn();
  const fetch = vi.fn(async () =>
    Response.json({ user: { emailVerified: true }, session: { id: 'session' } }),
  );
  render(
    <StrictMode>
      <LandingPage fetchImpl={fetch} navigate={navigate} />
    </StrictMode>,
  );
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/app'));
  expect(navigate).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('keeps anonymous, malformed, and failed session probes on the landing page', async () => {
  const navigate = vi.fn();
  for (const response of [
    Response.json(null),
    Response.json({ user: { emailVerified: false }, session: { id: 'session' } }),
    new Response(null, { status: 503 }),
  ]) {
    await expect(
      redirectSignedInLanding(
        vi.fn(async () => response),
        navigate,
      ),
    ).resolves.toBe(false);
  }
  expect(navigate).not.toHaveBeenCalled();
});

it('aborts a landing session probe when its owner unmounts', async () => {
  let signal: AbortSignal | undefined;
  const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  });
  vi.stubGlobal('fetch', fetch);
  const view = render(<LandingPage />);
  view.unmount();
  expect(signal?.aborted).toBe(true);
});

it('rejects a session without a session id', async () => {
  const navigate = vi.fn();
  await expect(
    redirectSignedInLanding(
      vi.fn(async () => Response.json({ user: { emailVerified: true }, session: {} })),
      navigate,
    ),
  ).resolves.toBe(false);
  expect(navigate).not.toHaveBeenCalled();
});

it('does not redirect after the bounded probe timeout', async () => {
  vi.useFakeTimers();
  const navigate = vi.fn();
  const fetch = vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted'))),
      ),
  );
  const result = redirectSignedInLanding(fetch, navigate);
  await vi.advanceTimersByTimeAsync(3_001);
  await expect(result).resolves.toBe(false);
  expect(navigate).not.toHaveBeenCalled();
});

it('does not start a probe for an already-aborted owner', async () => {
  const navigate = vi.fn();
  const controller = new AbortController();
  controller.abort();
  const fetch = vi.fn(async () =>
    Response.json({ user: { emailVerified: true }, session: { id: 'session' } }),
  );
  await expect(redirectSignedInLanding(fetch, navigate, controller.signal)).resolves.toBe(false);
  expect(fetch).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
});
