import type { BrowserReport } from '@app-health/contracts';
import { ArrowRight, BarChart3, Clock3, MousePointer2, Radio } from 'lucide-react';
import { AnalyticsChart } from './AnalyticsChart.js';
import { Badge } from './components/ui/badge.js';
import { Button } from './components/ui/button.js';
import { Card, CardContent, CardHeader } from './components/ui/card.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './components/ui/table.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs.js';

const formatCount = (value: number) => value.toLocaleString();
const formatLastSeen = (timestamp: number) =>
  new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function MetricCard(props: {
  label: string;
  value: string;
  note: string;
  icon: typeof BarChart3;
  live?: boolean;
}): JSX.Element {
  const { label, value, note, icon: Icon, live } = props;
  return (
    <Card className="shadow-none">
      <CardContent className="p-5">
        <div className="flex items-center justify-between text-muted-foreground">
          <span className="text-xs font-medium">{label}</span>
          {live ? (
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-50" />
              <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
            </span>
          ) : (
            <Icon className="size-4" />
          )}
        </div>
        <p className="mt-3 text-3xl font-semibold tracking-tight tabular-nums">{value}</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{note}</p>
      </CardContent>
    </Card>
  );
}

function RankingCard(props: {
  title: string;
  label: string;
  rows: { name: string; count: number }[];
}): JSX.Element {
  const { title, label, rows } = props;
  const max = Math.max(1, ...rows.map((row) => row.count));
  return (
    <Card className="shadow-none">
      <CardHeader className="flex flex-row items-center justify-between border-b pb-4">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="text-xs text-muted-foreground">{label}</span>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length ? (
          <ol>
            {rows.map((row) => (
              <li
                key={row.name}
                className="relative flex items-center gap-4 border-b px-5 py-3.5 last:border-0"
              >
                <span
                  aria-hidden="true"
                  className="absolute inset-y-1 left-0 bg-primary/7"
                  style={{ width: `${(row.count / max) * 100}%` }}
                />
                <span
                  className="relative min-w-0 flex-1 truncate font-mono text-xs"
                  title={row.name}
                >
                  {row.name}
                </span>
                <strong className="relative text-xs font-medium tabular-nums">
                  {formatCount(row.count)}
                </strong>
              </li>
            ))}
          </ol>
        ) : (
          <p className="p-8 text-center text-sm text-muted-foreground">
            No activity in this period.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function EventTable(props: {
  rows: BrowserReport['events'];
  selected: string;
  onSelect: (event: string) => void;
}): JSX.Element {
  const { rows, selected, onSelect } = props;
  return (
    <Card className="overflow-hidden shadow-none">
      <CardHeader className="flex flex-row items-start justify-between gap-4 border-b">
        <div>
          <h2 className="text-sm font-semibold">Tracked events</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Open an event to see its trend, pages, and sources.
          </p>
        </div>
        <Badge variant="secondary" className="font-normal">
          {rows.length} {rows.length === 1 ? 'event' : 'events'}
        </Badge>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5 text-xs text-muted-foreground">Event name</TableHead>
                <TableHead className="text-right text-xs text-muted-foreground">
                  Occurrences
                </TableHead>
                <TableHead className="hidden text-right text-xs text-muted-foreground sm:table-cell">
                  Last received
                </TableHead>
                <TableHead className="w-12">
                  <span className="sr-only">Explore</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  key={row.name}
                  data-state={selected === row.name ? 'selected' : undefined}
                >
                  <TableCell className="max-w-52 pl-5">
                    <button
                      className="w-full truncate text-left font-mono text-xs font-medium hover:text-primary"
                      onClick={() => onSelect(row.name)}
                      aria-pressed={selected === row.name}
                    >
                      {row.name}
                    </button>
                  </TableCell>
                  <TableCell className="text-right text-xs font-medium tabular-nums">
                    {formatCount(row.count)}
                  </TableCell>
                  <TableCell className="hidden text-right text-xs text-muted-foreground sm:table-cell">
                    {formatLastSeen(row.last_seen)}
                  </TableCell>
                  <TableCell className="pr-4 text-right">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Explore ${row.name}`}
                      onClick={() => onSelect(row.name)}
                    >
                      <ArrowRight />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="px-6 py-14 text-center">
            <span className="mx-auto flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <MousePointer2 className="size-5" />
            </span>
            <h3 className="mt-4 text-sm font-medium">
              Your product has a story. Start tracking it.
            </h3>
            <p className="mx-auto mt-2 max-w-lg text-xs leading-5 text-muted-foreground">
              Send an intentional event when someone signs up, starts a checkout, or completes an
              important action.
            </p>
            <code className="mt-5 inline-block rounded-md bg-muted px-3 py-2 text-xs">
              window.appHealth.track('signup.completed')
            </code>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export interface AnalyticsReportProps {
  report: BrowserReport;
  mode: 'web' | 'events';
  selected: string;
  metric: 'pageviews' | 'events';
  range: string;
  sourceNote: string;
  active: number | null;
  totals: { pageviews: number; events: number };
  onMetric: (value: 'pageviews' | 'events') => void;
  onEvent: (event: string) => void;
}

function ReportMetrics(props: AnalyticsReportProps): JSX.Element {
  const { selected, totals, active } = props;
  return (
    <div className={`grid gap-3 md:grid-cols-2 ${selected ? 'xl:grid-cols-3' : 'xl:grid-cols-4'}`}>
      {!selected ? (
        <MetricCard
          label="Page views"
          value={formatCount(totals.pageviews)}
          note="Pages opened in this period"
          icon={BarChart3}
        />
      ) : null}
      <MetricCard
        label={selected ? 'Event occurrences' : 'Product events'}
        value={formatCount(totals.events)}
        note="Named actions received"
        icon={MousePointer2}
      />
      <MetricCard
        label="Sessions"
        value={formatCount(props.report.sessions)}
        note={
          props.report.sampled ? 'Sampled lower bound for this period' : 'Sessions in this period'
        }
        icon={Clock3}
      />
      <MetricCard
        label="Active now"
        value={active === null ? '—' : formatCount(active)}
        note="Browser sessions · last 45 seconds"
        icon={Radio}
        live
      />
    </div>
  );
}

function ReportChart(props: AnalyticsReportProps): JSX.Element {
  const { report, selected, metric, range, sourceNote, totals, onMetric } = props;
  return (
    <Card className="shadow-none">
      <Tabs value={metric} onValueChange={(value) => onMetric(value as typeof metric)}>
        <CardHeader className="flex flex-col gap-4 border-b sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold">
              {selected || (metric === 'events' ? 'Event activity' : 'Traffic over time')}
            </h2>
            <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock3 className="size-3" /> {range === '24h' ? 'Last 24 hours' : 'Last hour'} ·{' '}
              {sourceNote}
            </p>
          </div>
          <TabsList aria-label="Chart metric">
            {!selected ? (
              <TabsTrigger value="pageviews" onClick={() => onMetric('pageviews')}>
                Page views
              </TabsTrigger>
            ) : null}
            <TabsTrigger value="events" onClick={() => onMetric('events')}>
              Product events
            </TabsTrigger>
          </TabsList>
        </CardHeader>
        <CardContent className="pt-5">
          <TabsContent value="pageviews">
            <AnalyticsChart series={report.series} metric="pageviews" />
          </TabsContent>
          <TabsContent value="events">
            <AnalyticsChart series={report.series} metric="events" />
          </TabsContent>
          {totals.pageviews === 0 && totals.events === 0 ? (
            <p className="mt-3 text-center text-xs text-muted-foreground">
              No activity in this period. Install the tracker or choose another project.
            </p>
          ) : null}
        </CardContent>
      </Tabs>
    </Card>
  );
}

function ReportRankings(props: AnalyticsReportProps): JSX.Element {
  const { report, selected } = props;
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <RankingCard
        title={selected ? 'Where this event happens' : 'Top pages'}
        label={selected ? 'Events' : 'Views'}
        rows={report.pages}
      />
      <RankingCard
        title={selected ? 'Event referral sources' : 'Referral sources'}
        label={selected ? 'Events' : 'Views'}
        rows={report.sources}
      />
    </div>
  );
}

export function AnalyticsReport(props: AnalyticsReportProps): JSX.Element {
  const { report, mode, selected, onEvent } = props;
  return (
    <>
      {mode === 'events' ? (
        <EventTable rows={report.events} selected={selected} onSelect={onEvent} />
      ) : null}
      <ReportMetrics {...props} />
      <ReportChart {...props} />
      <ReportRankings {...props} />
      {mode === 'web' ? (
        <EventTable rows={report.events} selected={selected} onSelect={onEvent} />
      ) : null}
    </>
  );
}
