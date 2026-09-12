interface ProductAnalyticsConfig {
  publicKey: string;
  ingestOrigin: string;
}

const CONFIG_PATH = '/v1/product-analytics/config';
const TRACKER_PATH = '/tracker.js';
const CONFIG_TIMEOUT_MS = 3000;
let loadPromise: Promise<void> | null = null;

function safeOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.hostname.length > 0 &&
      !parsed.username &&
      !parsed.password &&
      parsed.pathname === '/' &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

function validConfig(value: unknown): value is ProductAnalyticsConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  return (
    config.enabled !== false &&
    typeof config.publicKey === 'string' &&
    config.publicKey.startsWith('ahk_pub_') &&
    safeOrigin(config.ingestOrigin)
  );
}

function trackerAlreadyPresent(): boolean {
  return Boolean(
    document.querySelector(
      'script[data-app-health-product-analytics="true"], script[src$="/tracker.js"]',
    ),
  );
}

function injectTracker(config: ProductAnalyticsConfig): void {
  if (trackerAlreadyPresent()) return;
  const script = document.createElement('script');
  script.defer = true;
  script.src = TRACKER_PATH;
  script.dataset.key = config.publicKey;
  script.dataset.endpoint = `${config.ingestOrigin}/v1/browser`;
  script.dataset.appHealthProductAnalytics = 'true';
  document.head.appendChild(script);
}

async function fetchConfig(): Promise<ProductAnalyticsConfig | null> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const request = fetch(`${location.origin}${CONFIG_PATH}`, {
      method: 'GET',
      credentials: 'omit',
      signal: controller.signal,
    });
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error('config timeout'));
      }, CONFIG_TIMEOUT_MS);
    });
    const response = await Promise.race([request, deadline]);
    if (!response.ok) return null;
    const value: unknown = await response.json();
    return validConfig(value) ? value : null;
  } catch {
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** Load the server opt-in and inject the existing tracker without delaying React. */
export function loadProductAnalytics(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = fetchConfig()
    .then((config) => {
      if (config) injectTracker(config);
    })
    .catch(() => undefined);
  return loadPromise;
}
