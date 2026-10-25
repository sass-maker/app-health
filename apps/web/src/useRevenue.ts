import { useEffect, useState } from 'react';
import { ProviderRevenueReportV1, RevenueReportV1 } from '@app-health/contracts';
import { apiUrl, ownerFetch } from './lib/owner-fetch.js';

export type RevenueScope = {
  app_id: string;
  environment_id: string;
  range: '1h' | '24h' | '7d' | '30d';
};
export function useRevenue(
  scope: RevenueScope,
  ownerToken: string,
  open: boolean,
  mode: string,
  breakdown: string,
  options: { revision: number; basis: 'custom' | 'provider' },
) {
  const { revision, basis } = options;
  const [result, setResult] = useState<{
    key: string;
    report: RevenueReportV1 | ProviderRevenueReportV1;
  } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const key = JSON.stringify([
    ownerToken,
    scope.app_id,
    scope.environment_id,
    scope.range,
    mode,
    breakdown,
    basis,
  ]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const duration = { '1h': 3600000, '24h': 86400000, '7d': 604800000, '30d': 2592000000 }[
      scope.range
    ];
    const to = Date.now();
    const params = new URLSearchParams({
      app_id: scope.app_id,
      environment_id: scope.environment_id,
      from: String(to - duration),
      to: String(to),
      mode,
      breakdown,
    });
    setLoading(true);
    setError('');
    void ownerFetch(
      apiUrl(`/v1/analytics/${basis === 'provider' ? 'provider-revenue' : 'revenue'}?${params}`),
      ownerToken,
      {
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        if (!response.ok)
          throw new Error('Recorded revenue could not load. Retry or choose a shorter period.');
        const report = (basis === 'provider' ? ProviderRevenueReportV1 : RevenueReportV1).parse(
          await response.json(),
        );
        if (!controller.signal.aborted) setResult({ key, report });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setResult(null);
          setError('Recorded revenue could not load. Retry or choose a shorter period.');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [
    open,
    ownerToken,
    scope.app_id,
    scope.environment_id,
    scope.range,
    mode,
    breakdown,
    basis,
    revision,
    key,
  ]);
  return { report: result?.key === key ? result.report : null, error, loading };
}
