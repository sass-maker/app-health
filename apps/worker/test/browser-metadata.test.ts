import { describe, expect, it } from 'vitest';
import { browserMetadata } from '../src/browser-metadata.js';

const attribution = (source: string, medium = '') => ({
  source,
  medium,
  campaign: '',
  content: '',
  term: '',
  entry_path: '/',
});
describe('coarse browser metadata', () => {
  it('uses trusted edge country and discards raw network identifiers', () => {
    const request = new Request('https://ingest.example/v1/browser', {
      headers: {
        'user-agent': 'Mozilla/5.0 (iPhone) Version/17 Mobile Safari/605.1',
        'cf-ipcountry': 'US',
        'x-forwarded-for': '192.0.2.1',
      },
    });
    Object.defineProperty(request, 'cf', { value: { country: 'IN' } });
    expect(browserMetadata(request, attribution('google.com'))).toEqual({
      device: 'Mobile',
      browser: 'Safari',
      country: 'IN',
      channel: 'Organic search',
    });
    expect(
      browserMetadata(new Request('https://example.test', { headers: { 'cf-ipcountry': 'US' } }))
        .country,
    ).toBe('Unknown');
  });
  it('gives explicit campaign medium priority and uses bounded category labels', () => {
    const request = new Request('https://example.test');
    for (const [source, medium, channel] of [
      ['google.com', 'cpc', 'Paid'],
      ['newsletter', 'email', 'Email'],
      ['t.co', '', 'Social'],
      ['evilgoogle.com', '', 'Referral'],
      ['', '', 'Direct / unknown'],
    ])
      expect(browserMetadata(request, attribution(source, medium)).channel).toBe(channel);
    expect(browserMetadata(request).device).toBe('Unknown');
  });
});
