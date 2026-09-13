import { describe, expect, it } from 'vitest';
import { analyticsSourceChannel, normalizeAnalyticsSource } from '../src/analytics-source.js';

describe('analytics source normalization', () => {
  it('groups real hostnames and subdomains while rejecting lookalikes', () => {
    expect(normalizeAnalyticsSource('www.reddit.com')).toBe('Reddit');
    expect(normalizeAnalyticsSource('old.redd.it')).toBe('Reddit');
    expect(normalizeAnalyticsSource('mobile.twitter.com')).toBe('X');
    expect(normalizeAnalyticsSource('evilgoogle.com')).toBe('evilgoogle.com');
    expect(normalizeAnalyticsSource('google.com.evil.test')).toBe('google.com.evil.test');
    expect(normalizeAnalyticsSource('https://evil.example/.reddit.com/path')).toBe(
      'https://evil.example/.reddit.com/path',
    );
  });

  it('recognizes common UTM source aliases without requiring a URL', () => {
    expect(normalizeAnalyticsSource('fb')).toBe('Facebook');
    expect(normalizeAnalyticsSource('ig')).toBe('Instagram');
    expect(normalizeAnalyticsSource('twitter')).toBe('X');
    expect(normalizeAnalyticsSource('yt')).toBe('YouTube');
    expect(normalizeAnalyticsSource('partner_launch')).toBe('partner_launch');
    expect(normalizeAnalyticsSource(' www.example.com ')).toBe(' www.example.com ');
    expect(normalizeAnalyticsSource(' fb ')).toBe(' fb ');
  });

  it('uses explicit mediums before source inference', () => {
    expect(analyticsSourceChannel('google.com', 'cpc')).toBe('Paid');
    expect(analyticsSourceChannel('newsletter', 'email')).toBe('Email');
    expect(analyticsSourceChannel('facebook.com', 'social_media')).toBe('Social');
    expect(analyticsSourceChannel('example.test', 'organic')).toBe('Organic search');
  });

  it('returns Unknown when there is no attribution evidence', () => {
    expect(normalizeAnalyticsSource('')).toBe('Unknown');
    expect(analyticsSourceChannel('', '')).toBe('Unknown');
    expect(analyticsSourceChannel('   ', '   ')).toBe('Unknown');
  });
});
