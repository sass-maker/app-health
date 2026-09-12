import { describe, expect, it } from 'vitest';
import { productAnalyticsHref } from '../src/lib/product-links.js';

describe('productAnalyticsHref', () => {
  it('creates the canonical internal analytics link', () => {
    expect(productAnalyticsHref({ appId: 'app/one', environmentId: 'prod one' })).toBe(
      '/app?project=app%2Fone&environment=prod+one#analytics',
    );
  });

  it('retains the legacy positional call used by project cards', () => {
    expect(productAnalyticsHref('app-one', 'env-prod')).toBe(
      '/app?project=app-one&environment=env-prod#analytics',
    );
  });
});
