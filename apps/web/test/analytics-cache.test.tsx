import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AnalyticsCacheProvider } from '../src/AnalyticsCache.js';
import { useBrowserReport } from '../src/useAnalytics.js';

const report = {
  from: 1,
  to: 2,
  sampled: false,
  source: 'local',
  series: [],
  pages: [],
  sources: [],
  events: [],
  sessions: 7,
};
function Report({ owner }: { owner: string }) {
  const state = useBrowserReport(owner, '24h', 'app', 'env', '');
  return (
    <>
      <span>{state.report ? `Sessions: ${state.report.sessions}` : 'Loading'}</span>
      <button onClick={state.reload}>Refresh</button>
    </>
  );
}
function Dashboard({ visible, owner = 'owner' }: { visible: boolean; owner?: string }) {
  return (
    <AnalyticsCacheProvider>{visible ? <Report owner={owner} /> : null}</AnalyticsCacheProvider>
  );
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('reuses a recent report on navigation, refreshes explicitly, and expires after a minute', async () => {
  let now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const fetch = vi.fn(async () => Response.json(report));
  vi.stubGlobal('fetch', fetch);
  const view = render(<Dashboard visible />);
  await screen.findByText('Sessions: 7');
  expect(fetch).toHaveBeenCalledTimes(1);
  view.rerender(<Dashboard visible={false} />);
  view.rerender(<Dashboard visible />);
  expect(screen.getByText('Sessions: 7')).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText('Refresh'));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  await screen.findByText('Sessions: 7');
  view.rerender(<Dashboard visible={false} />);
  now += 60_001;
  view.rerender(<Dashboard visible />);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
});

it('never reuses another owner report or retains reports after dashboard unmount', async () => {
  const fetch = vi.fn(async () => Response.json(report));
  vi.stubGlobal('fetch', fetch);
  const view = render(<Dashboard visible />);
  await screen.findByText('Sessions: 7');
  view.rerender(<Dashboard visible owner="other" />);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  view.unmount();
  render(<Dashboard visible />);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
});
