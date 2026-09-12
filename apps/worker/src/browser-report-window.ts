import type { BrowserReportFilter } from '@app-health/contracts';

export function reportWindow(filter: BrowserReportFilter, now: number) {
  const duration =
    filter.range === '1h'
      ? 3_600_000
      : filter.range === '7d'
        ? 7 * 86_400_000
        : filter.range === '30d'
          ? 30 * 86_400_000
          : 86_400_000;
  return { from: now - duration, to: now, step: duration / 24 };
}
