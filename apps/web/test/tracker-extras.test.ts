import { afterEach, expect, it, vi } from 'vitest';
import { start, assetURL } from '../public/tracker-extras.js';
import type { AppHealthTracker } from '../public/tracker.js';

let cleanup: ReturnType<typeof start> | undefined;
const preventNavigation = (event: Event) => event.preventDefault();
afterEach(() => {
  cleanup?.();
  document.body.replaceChildren();
  window.removeEventListener('click', preventNavigation);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function setup(data: Record<string, string> = {}) {
  window.addEventListener('click', preventNavigation);
  const track = vi.fn();
  const script = document.createElement('script');
  Object.assign(script.dataset, data);
  cleanup = start({ track } as unknown as AppHealthTracker, script);
  return track;
}
function click(href: string, attributes: Record<string, string> = {}) {
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.textContent = 'private@example.com';
  for (const [key, value] of Object.entries(attributes)) anchor.setAttribute(key, value);
  document.body.appendChild(anchor);
  anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  anchor.remove();
}
it('requires explicit opt-in for automatic tracking and reports an owner-marked 404', () => {
  const track = setup({ '404': 'true' });
  click('https://example.com/private?secret=value#private');
  expect(track.mock.calls).toEqual([['page_not_found']]);
});
it('captures only destination hostname or extension without link text or URL secrets', () => {
  const track = setup({ autotrack: 'true' });
  click('https://example.com/alice/private?secret=value#token');
  click('/files/private-account.pdf?access=secret', { download: 'private-user.pdf' });
  click('/internal');
  click('mailto:private@example.com');
  expect(track.mock.calls).toEqual([
    ['outbound_click', { hostname: 'example.com' }],
    ['file_download', { hostname: location.hostname, extension: 'pdf' }],
  ]);
  expect(JSON.stringify(track.mock.calls)).not.toContain('private');
  cleanup?.();
  click('https://another.example/');
  expect(track).toHaveBeenCalledTimes(2);
});
it('ignores canceled interactions and non-primary clicks', () => {
  const track = setup({ autotrack: '' });
  const anchor = document.createElement('a');
  anchor.href = 'https://example.com/';
  anchor.addEventListener('click', (event) => event.preventDefault());
  document.body.appendChild(anchor);
  anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 1, cancelable: true }));
  expect(track).not.toHaveBeenCalled();
});

it('reports unknown download suffixes as other rather than capturing path fragments', () => {
  const track = setup({ autotrack: 'true' });
  click('/private.account?secret=value', { download: '' });
  expect(track.mock.calls).toEqual([
    ['file_download', { hostname: location.hostname, extension: 'other' }],
  ]);
});
it('reports each coarse milestone once per page and cancels scheduled work on cleanup', async () => {
  vi.useFakeTimers();
  vi.spyOn(document.documentElement, 'scrollHeight', 'get').mockReturnValue(2000);
  vi.stubGlobal('innerHeight', 1000);
  vi.stubGlobal('scrollY', 800);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const track = setup({ scroll: 'true' });
  window.dispatchEvent(new Event('scroll'));
  window.dispatchEvent(new Event('scroll'));
  await vi.advanceTimersByTimeAsync(20);
  expect(track.mock.calls).toEqual([25, 50, 75].map((percent) => ['scroll_depth', { percent }]));
  window.dispatchEvent(new Event('scroll'));
  await vi.advanceTimersByTimeAsync(20);
  expect(track).toHaveBeenCalledTimes(3);
  vi.stubGlobal('scrollY', 1000);
  window.dispatchEvent(new Event('scroll'));
  await vi.advanceTimersByTimeAsync(20);
  expect(track.mock.calls.at(-1)).toEqual(['scroll_depth', { percent: 100 }]);
  cleanup?.page?.();
  window.dispatchEvent(new Event('scroll'));
  await vi.advanceTimersByTimeAsync(20);
  expect(track).toHaveBeenCalledTimes(8);
  cleanup?.page?.();
  window.dispatchEvent(new Event('scroll'));
  cleanup?.();
  await vi.advanceTimersByTimeAsync(20);
  expect(track).toHaveBeenCalledTimes(8);
});
it.each(['hidden', 'prerender', 'short'])('does not measure %s pages', async (mode) => {
  vi.useFakeTimers();
  vi.spyOn(document.documentElement, 'scrollHeight', 'get').mockReturnValue(
    mode === 'short' ? 500 : 2000,
  );
  vi.stubGlobal('innerHeight', 1000);
  vi.stubGlobal('scrollY', 1000);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(
    mode === 'hidden' ? 'hidden' : 'visible',
  );
  Object.defineProperty(document, 'prerendering', {
    configurable: true,
    value: mode === 'prerender',
  });
  try {
    const track = setup({ scroll: 'true' });
    window.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(20);
    expect(track).not.toHaveBeenCalled();
  } finally {
    Reflect.deleteProperty(document, 'prerendering');
  }
});
it.each([
  [
    'https://health.example/assets/tracker.js?v=2026.10&secret=private#token',
    'https://health.example/assets/vitals.js?v=2026.10',
  ],
  ['https://health.example/tracker.js?v=private%40example.com', 'https://health.example/vitals.js'],
  ['', undefined],
  ['https://health.example/other.js', undefined],
])('resolves only the version token from %s', (src, expected) => {
  const script = document.createElement('script');
  if (src) script.src = src;
  expect(assetURL(script, 'vitals.js')).toBe(expected);
});
