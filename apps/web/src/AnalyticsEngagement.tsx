import type { BrowserReport } from '@app-health/contracts';
import { AnalyticsRanking } from './AnalyticsRanking.js';

export function AnalyticsEngagement({ report }: { report: BrowserReport }): JSX.Element | null {
  const metrics = report.engagement;
  if (!metrics) return null;
  const duration = metrics.average_session_duration_ms;
  const cells = [
    [
      'Pages per session',
      metrics.pages_per_session?.toFixed(1) ?? '—',
      'Page views divided by sessions with a page view',
    ],
    [
      'Bounce rate',
      metrics.bounce_rate === null ? '—' : `${(metrics.bounce_rate * 100).toFixed(1)}%`,
      'Sessions with exactly one page view',
    ],
    [
      'Observed visit duration',
      duration === null ? '—' : `${Math.round(duration / 1000).toLocaleString()}s`,
      'Time between the first and last recorded event',
    ],
  ];
  return (
    <section aria-label="Session engagement" className="space-y-4">
      <div className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3">
        {cells.map(([label, value, note]) => (
          <div key={label} className="bg-card p-4">
            <h2 className="text-xs text-muted-foreground">{label}</h2>
            <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">{note}</p>
          </div>
        ))}
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        {report.sampled ? 'Session engagement is unavailable for sampled data. ' : ''}
        Based on events inside the selected period. A single recorded event has a zero-second span;
        this does not measure time spent reading. Exits are the last observed page in each session.
      </p>
      {metrics.exit_pages.length ? (
        <AnalyticsRanking title="Exit pages" label="Sessions" rows={metrics.exit_pages} />
      ) : null}
    </section>
  );
}
