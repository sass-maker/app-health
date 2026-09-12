import type { SharedAnalytics } from '@app-health/contracts/sharing';
import { AnalyticsChart } from './AnalyticsChart.js';
import { AnalyticsRanking } from './AnalyticsRanking.js';
import { Button } from './components/ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card.js';

function Statistic({ label, value, note }: { label: string; value: number | null; note: string }) {
  return (
    <Card role="group" aria-label={label} className="gap-3 py-4 shadow-none">
      <CardHeader className="gap-2 px-4 pb-0">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-3xl tracking-tight tabular-nums">
          {value?.toLocaleString() ?? '—'}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 text-xs leading-5 text-muted-foreground">{note}</CardContent>
    </Card>
  );
}

export function PublicAnalyticsReport({
  data,
  embed,
  stale,
  refreshing,
  retry,
}: {
  data: SharedAnalytics;
  embed: boolean;
  stale: boolean;
  refreshing: boolean;
  retry: () => void;
}) {
  const details = data.breakdowns;
  const active = stale ? null : data.live.active;
  const series = data.traffic?.series.map((row) => ({ ...row, events: 0 })) ?? [];
  return (
    <div className="space-y-4">
      <div
        className="flex min-h-8 flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"
        role="status"
      >
        <span className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={`size-2 rounded-full ${active === null ? 'bg-muted-foreground' : 'bg-emerald-500'}`}
          />
          {stale
            ? refreshing
              ? 'Refreshing · showing last received traffic'
              : 'Connection interrupted · showing last received traffic'
            : refreshing
              ? 'Updating analytics…'
              : 'Live sessions refresh every 10 seconds'}
        </span>
        {stale ? (
          <Button variant="outline" size="sm" onClick={retry}>
            Try again
          </Button>
        ) : (
          <span>Last 24 hours</span>
        )}
      </div>
      <section
        aria-label="Live and traffic analytics"
        className={`grid grid-cols-2 gap-3 sm:gap-4 ${details ? 'lg:grid-cols-4' : ''}`}
      >
        <Statistic
          label="Live sessions"
          value={active}
          note={active === null ? 'Live count unavailable' : 'Active within the last 45 seconds'}
        />
        <Statistic
          label="Page views"
          value={data.traffic?.pageviews ?? null}
          note="Pages opened in the last 24 hours"
        />
        {details ? (
          <>
            <Statistic
              label="Sessions"
              value={details.sessions}
              note={
                data.sampled
                  ? 'Sampled lower bound · last 24 hours'
                  : 'Browser sessions · last 24 hours'
              }
            />
            <Statistic
              label="Product events"
              value={details.events}
              note="Intentional actions · last 24 hours"
            />
          </>
        ) : null}
      </section>
      <Card className="shadow-none">
        <CardHeader className="border-b">
          <CardTitle className="text-sm">Traffic over time</CardTitle>
          <CardDescription>Page views · last 24 hours</CardDescription>
        </CardHeader>
        <CardContent className="pt-5">
          {data.traffic ? (
            <AnalyticsChart series={series} compact={embed} onlyMetric={true} />
          ) : (
            <p className="py-16 text-center text-sm text-muted-foreground">
              Traffic is temporarily unavailable.
            </p>
          )}
          {data.traffic?.pageviews === 0 ? (
            <p className="mt-3 text-center text-xs text-muted-foreground">
              No page views received in this period.
            </p>
          ) : null}
        </CardContent>
      </Card>
      {details ? (
        <section aria-label="Traffic breakdowns" className="grid gap-4 md:grid-cols-2">
          <AnalyticsRanking
            title="Top routes"
            label="Page views"
            rows={details.pages}
            total={data.traffic?.pageviews}
          />
          <AnalyticsRanking
            title="Top sources"
            label="Page views"
            rows={details.sources}
            total={data.traffic?.pageviews}
          />
        </section>
      ) : null}
      <p className="text-xs leading-relaxed text-muted-foreground">
        {data.source === 'local' ? 'Local development data' : 'Traffic totals may arrive later'}
        {data.sampled ? ' · Sampled estimates' : ''} · Updated{' '}
        {new Date(data.updated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        {details ? ' · Sessions are browser visits, not unique people.' : ''}
      </p>
    </div>
  );
}
