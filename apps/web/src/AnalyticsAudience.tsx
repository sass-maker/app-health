import type { BrowserReport } from '@app-health/contracts';
import { AnalyticsRanking } from './AnalyticsRanking.js';

export function AnalyticsAudience({
  report,
  breakdown,
  metric = 'pageviews',
}: {
  report: BrowserReport;
  breakdown: 'audience' | 'acquisition' | 'technology';
  metric?: 'pageviews' | 'events';
}): JSX.Element {
  const audience = report.audience;
  if (!audience)
    return (
      <p className="text-sm text-muted-foreground">
        Audience identity is unavailable for this period.
      </p>
    );
  const total = report.series.reduce((sum, row) => sum + row[metric], 0);
  const previous = report.previous?.visitors;
  const change = previous === undefined ? null : audience.visitors - previous;
  const groups =
    breakdown === 'audience'
      ? [
          ['Channels', audience.channels],
          ['Entry pages', audience.entry_pages],
        ]
      : breakdown === 'acquisition'
        ? [
            ['Campaigns', audience.campaigns],
            ['Channels', audience.channels],
          ]
        : [
            ['Devices', audience.devices],
            ['Browsers', audience.browsers],
            ['Countries', audience.countries],
          ];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ['Visitors', audience.visitors],
          ['New sessions', audience.new_sessions],
          ['Returning sessions', audience.returning_sessions],
          ['Unidentified sessions', audience.unidentified_sessions],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded-lg border bg-card p-4">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums">
              {Number(value).toLocaleString()}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {report.sampled ? 'Sampled lower bound' : 'Browser-scoped'}
            </p>
            {label === 'Visitors' && change !== null ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {change === 0
                  ? 'No change'
                  : `${change > 0 ? '+' : ''}${change.toLocaleString()} vs previous`}
              </p>
            ) : null}
          </div>
        ))}
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        {groups.map(([title, rows]) => (
          <AnalyticsRanking
            key={String(title)}
            title={String(title)}
            label={metric === 'events' ? 'Occurrences' : 'Page views'}
            rows={rows as { name: string; count: number }[]}
            total={total}
          />
        ))}
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        Visitors are browser-scoped. Legacy sessions without identity appear as unknown; sampled
        unique counts are lower bounds.
      </p>
    </div>
  );
}
