import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { AnalyticsEngagement } from '../src/AnalyticsEngagement.js';
import { AnalyticsAudience } from '../src/AnalyticsAudience.js';

const report = {
  from: 1,
  to: 2,
  sampled: false,
  source: 'local' as const,
  series: [{ timestamp: 1, pageviews: 10, events: 0 }],
  pages: [],
  sources: [],
  events: [],
  sessions: 2,
  audience: {
    visitors: 2,
    new_sessions: 1,
    returning_sessions: 1,
    unidentified_sessions: 0,
    channels: [{ name: 'Direct', count: 10 }],
    campaigns: [],
    devices: [],
    browsers: [],
    countries: [
      { name: 'IN', count: 5 },
      { name: 'US', count: 3 },
      { name: 'Unknown', count: 2 },
    ],
    entry_pages: [],
  },
  previous: { pageviews: 5, events: 0, sessions: 1, visitors: 1 },
};

it('uses page views as the ranking denominator and labels identity states', () => {
  render(<AnalyticsAudience report={report} breakdown="audience" />);
  expect(screen.getAllByText('Page views').length).toBeGreaterThan(0);
  expect(screen.getByText('Returning sessions')).toBeTruthy();
  expect(screen.getByText('Unidentified sessions')).toBeTruthy();
  expect(screen.getByText('100.0%')).toBeTruthy();
  expect(screen.queryByText('500.0%')).toBeNull();
  expect(screen.getByText('+100% vs previous period')).toBeTruthy();
});

it('shows readable connection countries in the default audience report', () => {
  render(<AnalyticsAudience report={report} breakdown="audience" />);
  expect(screen.getByText('India')).toBeVisible();
  expect(screen.getByText('United States')).toBeVisible();
  expect(screen.getByText('Unknown')).toBeVisible();
  expect(screen.getByText(/may reflect a VPN/)).toBeVisible();
});

it('labels observed session metrics and preserves unavailable values', () => {
  const { rerender } = render(
    <AnalyticsEngagement
      report={{
        ...report,
        engagement: {
          pages_per_session: 2.5,
          bounce_rate: 0.25,
          average_session_duration_ms: 30000,
          exit_pages: [{ name: '/download', count: 1 }],
        },
      }}
    />,
  );
  expect(screen.getByText('2.5')).toBeVisible();
  expect(screen.getByText('25.0%')).toBeVisible();
  expect(screen.getByText('30s')).toBeVisible();
  expect(screen.getByText(/does not measure time spent reading/)).toBeVisible();
  rerender(
    <AnalyticsEngagement
      report={{
        ...report,
        sampled: true,
        engagement: {
          pages_per_session: null,
          bounce_rate: null,
          average_session_duration_ms: null,
          exit_pages: [],
        },
      }}
    />,
  );
  expect(screen.getAllByText('—')).toHaveLength(3);
  expect(screen.getByText(/unavailable for sampled data/)).toBeVisible();
  expect(screen.queryByText('Exit pages')).toBeNull();
});

it('uses the original country code when a readable country ranking is selected', () => {
  const onFilter = vi.fn();
  render(<AnalyticsAudience report={report} breakdown="audience" onFilter={onFilter} />);
  fireEvent.click(screen.getByRole('button', { name: 'Filter Countries by India' }));
  expect(onFilter).toHaveBeenCalledWith('country', 'IN');
});

it('shows stored acquisition dimensions and emits exact content filters', () => {
  const onFilter = vi.fn();
  render(
    <AnalyticsAudience
      report={{
        ...report,
        audience: {
          ...report.audience,
          mediums: [{ name: 'email', count: 3 }],
          contents: [{ name: 'hero-link', count: 2 }],
          terms: [{ name: 'storage tools', count: 1 }],
        },
      }}
      breakdown="acquisition"
      onFilter={onFilter}
    />,
  );
  expect(screen.getByRole('heading', { name: 'Mediums' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Campaign terms' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Filter Campaign content by hero-link' }));
  expect(onFilter).toHaveBeenCalledWith('content', 'hero-link');
});
