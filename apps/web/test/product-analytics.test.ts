import { beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'ahk_pub_product_test_key';

describe('loadProductAnalytics', () => {
  beforeEach(() => {
    vi.resetModules();
    document.head.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('fetches once and injects the configured tracker', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ publicKey: KEY, ingestOrigin: 'https://ingest.example.com' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { loadProductAnalytics } = await import('../src/lib/product-analytics.js');
    await Promise.all([loadProductAnalytics(), loadProductAnalytics()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const script = document.querySelector(
      'script[data-app-health-product-analytics="true"]',
    ) as HTMLScriptElement;
    expect(script).not.toBeNull();
    expect(script.defer).toBe(true);
    expect(script.src).toBe(`${location.origin}/tracker.js`);
    expect(script.dataset.key).toBe(KEY);
    expect(script.dataset.endpoint).toBe('https://ingest.example.com/v1/browser');
  });

  it.each([
    null,
    { enabled: false },
    { publicKey: 'ahk_secret', ingestOrigin: 'https://ingest.example.com' },
    { publicKey: KEY, ingestOrigin: 'https://user:pass@ingest.example.com' },
    { publicKey: KEY, ingestOrigin: 'https://ingest.example.com/path' },
  ])('does not inject for disabled or malformed config %#', async (config) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => config }));
    const { loadProductAnalytics } = await import('../src/lib/product-analytics.js');
    await loadProductAnalytics();
    expect(document.querySelector('script[data-app-health-product-analytics]')).toBeNull();
  });

  it('fails silently for fetch errors and timeout', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => new Promise<Response>(() => undefined)),
      );
      const { loadProductAnalytics } = await import('../src/lib/product-analytics.js');
      const pending = loadProductAnalytics();
      await vi.advanceTimersByTimeAsync(3001);
      await pending;
      expect(document.querySelector('script[data-app-health-product-analytics]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
