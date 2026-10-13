import type { ReactElement } from 'react';
import { AnalyticsComparison } from './AnalyticsComparison.js';
import { AnalyticsEngagement } from './AnalyticsEngagement.js';
import { AnalyticsRanking } from './AnalyticsRanking.js';
import type { BrowserReport, BrowserSegmentFilter } from '@app-health/contracts';
import {
  ArrowRight,
  BarChart3,
  Clock3,
  ListFilter,
  MousePointer2,
  Radio,
  Users,
} from 'lucide-react';
import { AnalyticsChart } from './AnalyticsChart.js';
import { Badge } from '@saas-maker/ui/components/badge';
import { Button } from '@saas-maker/ui/components/button';
import { Card, CardContent, CardHeader } from '@saas-maker/ui/components/card';
import { DataTable, type DataColumn } from './components/ResourceTable.js';
import { EmptyState } from '@saas-maker/ui/components/empty-state';
import { FilterBar } from '@saas-maker/ui/blocks/filter-bar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@saas-maker/ui/components/tabs';
import { AnalyticsAudience } from './AnalyticsAudience.js';

const periodLabels: Record<string, string> = {
  '1h': 'last hour',
  '24h': 'last 24 hours',
  '7d': 'last 7 days',
  '30d': 'last 30 days',
};
const formatCount = (value: number) => value.toLocaleString();
const formatLastSeen = (timestamp: number) =>
  new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function MetricCard(props: {
  label: string;
  value: number | null;
  note: string;
  icon: typeof BarChart3;
  live?: boolean;
  tone?: string;
  previous?: number;
  sampled?: boolean;
  unique?: boolean;
}): ReactElement {
  const { label, value, note, icon: Icon, live } = props;
  return (
    <Card className="py-0 shadow-none">
      <CardContent className="p-5">
        <div className="flex items-center justify-between text-muted-foreground">
          <span className="text-xs font-medium">{label.toLowerCase()}</span>
          {live ? (
            <span className="size-2 rounded-full bg-success" aria-hidden="true" />
          ) : (
            <Icon className="size-4" />
          )}
        </div>
        <p className="mt-3 text-3xl font-semibold tracking-tight tabular-nums">
          {value === null ? '—' : formatCount(value)}
        </p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{note.toLowerCase()}</p>
        <AnalyticsComparison
          label={label}
          current={value ?? 0}
          previous={props.previous}
          sampled={props.sampled}
          unique={props.unique}
        />
      </CardContent>
    </Card>
  );
}

function eventColumns(
  selected: string,
  onSelect: (event: string) => void,
): DataColumn<BrowserReport['events'][number]>[] {
  return [
    {
      id: 'name',
      header: 'event name',
      value: (row) => row.name,
      sortable: false,
      hideable: false,
      minWidth: '10rem',
      className: 'max-w-52',
      cell: (row) => (
        <button
          className="w-full truncate text-left font-mono text-xs font-medium hover:text-primary"
          onClick={() => onSelect(row.name)}
          aria-pressed={selected === row.name}
        >
          {row.name}
        </button>
      ),
    },
    {
      id: 'count',
      header: 'occurrences',
      value: (row) => row.count,
      sortable: false,
      hideable: false,
      align: 'right',
      className: 'text-xs font-medium tabular-nums',
      cell: (row) => formatCount(row.count),
    },
    {
      id: 'last_seen',
      header: 'last received',
      value: (row) => row.last_seen,
      sortable: false,
      hideable: false,
      align: 'right',
      className: 'hidden text-xs text-muted-foreground sm:table-cell',
      cell: (row) => formatLastSeen(row.last_seen),
    },
    {
      id: 'explore',
      header: 'explore',
      value: (row) => row.name,
      sortable: false,
      hideable: false,
      align: 'right',
      cell: (row) => (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Explore ${row.name}`}
          onClick={() => onSelect(row.name)}
        >
          <ArrowRight />
        </Button>
      ),
    },
  ];
}

function EventTable(props: {
  rows: BrowserReport['events'];
  selected: string;
  filtered?: boolean;
  onSelect: (event: string) => void;
}): ReactElement {
  const { rows, selected, onSelect } = props;
  if (!rows.length && props.filtered)
    return (
      <Card className="shadow-none">
        <CardContent className="p-0">
          <EmptyState
            title="no tracked product events in this segment."
            description="remove a filter or choose another period."
            className="py-6"
          />
        </CardContent>
      </Card>
    );
  return (
    <Card className="overflow-hidden shadow-none">
      <CardHeader className="flex flex-row items-start justify-between gap-4 border-b">
        <div>
          <h2 className="text-sm font-semibold">tracked events</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            select an event to inspect its trend and context.
          </p>
        </div>
        <Badge variant="secondary" className="font-normal">
          {rows.length} {rows.length === 1 ? 'event' : 'events'}
        </Badge>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length ? (
          <DataTable
            data={rows}
            columns={eventColumns(selected, onSelect)}
            getRowId={(row) => row.name}
            label="Tracked events"
            selectedId={selected}
            pageSize={Math.max(1, rows.length)}
            maxHeight="none"
            className="gap-0 [&>div:first-child]:hidden [&>div[role=region]]:rounded-none [&>div[role=region]]:border-0 [&_th:nth-child(3)]:hidden sm:[&_th:nth-child(3)]:table-cell [&_th:last-child>span]:sr-only"
          />
        ) : (
          <EmptyState
            icon={<MousePointer2 />}
            title="your product has a story. start tracking it."
            description="send an intentional event when someone signs up, starts a checkout, or completes an important action."
            primaryAction={
              <code className="rounded-md bg-muted px-3 py-2 text-xs">
                window.apphealth.track('signup.completed')
              </code>
            }
          />
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
  breakdown: 'audience' | 'acquisition' | 'technology';
  onBreakdown: (value: 'audience' | 'acquisition' | 'technology') => void;
  segmented?: boolean;
  onFilter?: (key: keyof BrowserSegmentFilter, value: string) => void;
}

function VisitorMetric({ report }: Pick<AnalyticsReportProps, 'report'>): ReactElement {
  return (
    <MetricCard
      label="Visitors"
      value={report.audience?.visitors ?? null}
      note={
        report.sampled
          ? 'Browser-scoped · sampled lower bound'
          : 'Recognized browsers in this period'
      }
      icon={Users}
      previous={report.previous?.visitors}
      sampled={report.sampled}
      unique={true}
    />
  );
}

function ReportMetrics(props: AnalyticsReportProps): ReactElement {
  const { mode, report, selected, totals, active } = props;
  const showPageViews = mode === 'web' && !selected;
  const showEventNames = mode === 'events' && !selected;
  return (
    <div
      className={`grid grid-cols-2 gap-3 ${selected ? 'xl:grid-cols-3' : mode === 'web' ? 'xl:grid-cols-5' : 'xl:grid-cols-4'}`}
    >
      {showPageViews ? <VisitorMetric report={report} /> : null}
      {showPageViews ? (
        <MetricCard
          tone="var(--chart-1)"
          label="Page views"
          previous={props.report.previous?.pageviews}
          sampled={props.report.sampled}
          value={totals.pageviews}
          note="Pages opened in this period"
          icon={BarChart3}
        />
      ) : null}
      {showEventNames ? (
        <MetricCard
          tone="var(--chart-1)"
          label="Event types"
          value={report.events.length}
          note="Distinct names received in this period"
          icon={ListFilter}
        />
      ) : null}
      <MetricCard
        tone="var(--chart-4)"
        label={selected ? 'Event occurrences' : 'Product events'}
        previous={props.report.previous?.events}
        sampled={props.report.sampled}
        value={totals.events}
        note="Named actions received"
        icon={MousePointer2}
      />
      <MetricCard
        tone="var(--chart-3)"
        label="Sessions"
        previous={props.report.previous?.sessions}
        sampled={props.report.sampled}
        unique={true}
        value={props.report.sessions}
        note={
          props.report.sampled ? 'Sampled lower bound for this period' : 'Sessions in this period'
        }
        icon={Clock3}
      />
      <MetricCard
        tone="var(--chart-2)"
        label={props.segmented ? 'Active now · unfiltered' : 'Active now'}
        value={active}
        note={
          props.segmented
            ? 'All project sessions · not filtered'
            : 'Browser sessions · last 45 seconds'
        }
        icon={Radio}
        live
      />
    </div>
  );
}

function ReportChart(props: AnalyticsReportProps): ReactElement {
  const { report, mode, selected, metric, range, sourceNote, totals, onMetric } = props;
  const showMetricPicker = mode === 'web' && !selected;
  return (
    <Card className="shadow-none">
      <Tabs value={metric} onValueChange={(value) => onMetric(value as typeof metric)}>
        <CardHeader className="flex flex-col gap-4 border-b sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold">
              {selected
                ? 'event activity'
                : mode === 'events'
                  ? 'product events over time'
                  : metric === 'events'
                    ? 'product events over time'
                    : 'traffic over time'}
            </h2>
            <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock3 className="size-3" /> {periodLabels[range]} · {sourceNote}
            </p>
          </div>
          {showMetricPicker ? (
            <FilterBar>
              <TabsList aria-label="Chart metric">
                <TabsTrigger value="pageviews" onClick={() => onMetric('pageviews')}>
                  page views
                </TabsTrigger>
                <TabsTrigger value="events" onClick={() => onMetric('events')}>
                  product events
                </TabsTrigger>
              </TabsList>
            </FilterBar>
          ) : null}
        </CardHeader>
        <CardContent className="pt-5">
          {showMetricPicker ? (
            <TabsContent value="pageviews">
              <AnalyticsChart series={report.series} metric="pageviews" />
            </TabsContent>
          ) : null}
          <TabsContent value="events">
            <AnalyticsChart series={report.series} metric="events" onlyMetric={!showMetricPicker} />
          </TabsContent>
          {totals.pageviews === 0 && totals.events === 0 ? (
            <p className="mt-3 text-center text-xs text-muted-foreground">
              {props.segmented
                ? 'no events match these filters. remove a filter or choose another period.'
                : 'no activity in this period. install the tracker or choose another project.'}
            </p>
          ) : null}
        </CardContent>
      </Tabs>
    </Card>
  );
}

function ReportRankings(props: AnalyticsReportProps): ReactElement {
  const { report, selected } = props;
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <AnalyticsRanking
        title={selected ? 'Where this event happens' : 'Top pages'}
        label={selected ? 'Events' : 'Views'}
        rows={report.pages}
        onSelect={props.onFilter ? (value) => props.onFilter?.('path', value) : undefined}
        total={selected ? props.totals.events : props.totals.pageviews}
      />
      <AnalyticsRanking
        title={selected ? 'Event referral sources' : 'Referral sources'}
        label={selected ? 'Events' : 'Views'}
        tone="var(--chart-2)"
        description={
          report.sources.some((row) => row.name === 'Unknown')
            ? 'unknown means no referring site was recorded: direct visits, private app handoffs, or older events.'
            : undefined
        }
        rows={report.sources}
        onSelect={props.onFilter ? (value) => props.onFilter?.('source', value) : undefined}
        total={selected ? props.totals.events : props.totals.pageviews}
      />
    </div>
  );
}

export function AnalyticsReport(props: AnalyticsReportProps): ReactElement {
  const { report, mode, selected, onEvent, breakdown, onBreakdown } = props;
  return (
    <>
      {mode === 'events' ? (
        <EventTable
          rows={report.events}
          selected={selected}
          onSelect={onEvent}
          filtered={props.segmented}
        />
      ) : null}
      <ReportMetrics {...props} />
      <ReportChart {...props} />
      {mode === 'web' || selected ? <ReportRankings {...props} /> : null}
      {!selected && mode === 'web' && !props.segmented ? (
        <AnalyticsEngagement report={report} />
      ) : null}
      {mode === 'web' || selected ? (
        <Tabs value={breakdown} onValueChange={(value) => onBreakdown(value as typeof breakdown)}>
          <FilterBar>
            <TabsList aria-label="Analytics breakdown">
              <TabsTrigger value="audience">audience</TabsTrigger>
              <TabsTrigger value="acquisition">acquisition</TabsTrigger>
              <TabsTrigger value="technology">technology</TabsTrigger>
            </TabsList>
          </FilterBar>
          <TabsContent value={breakdown}>
            <AnalyticsAudience
              report={report}
              breakdown={breakdown}
              onFilter={props.onFilter}
              metric={selected ? 'events' : 'pageviews'}
            />
          </TabsContent>
        </Tabs>
      ) : null}
      {mode === 'web' ? (
        <details className="rounded-lg border p-4">
          <summary className="cursor-pointer text-sm font-medium">
            tracked product events · {report.events.length} types
          </summary>
          <div className="mt-4">
            <EventTable
              rows={report.events}
              selected={selected}
              onSelect={onEvent}
              filtered={props.segmented}
            />
          </div>
        </details>
      ) : null}
    </>
  );
}
