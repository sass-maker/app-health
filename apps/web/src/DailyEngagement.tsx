import {
  DailyEngagementReportV1,
  type DailyEngagementReportV1 as Report,
} from '@app-health/contracts';
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CalendarDays, RefreshCw, Search } from 'lucide-react';
import { Badge } from './components/ui/badge.js';
import { Button } from './components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card.js';
import { Input } from './components/ui/input.js';
import { Skeleton } from './components/ui/skeleton.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './components/ui/table.js';

type Product = Report['products'][number];

function count(value: number | string | null): string {
  if (value === null) return 'Unknown';
  return typeof value === 'string' ? value : value.toLocaleString();
}

function captureCount(
  value: number | null,
  applicability:
    | Product['newsletter_applicability']
    | Product['native_sessions_applicability']
    | Product['browser_visitors_applicability']
    | Product['server_requests_applicability'],
): string {
  if (value !== null && value > 0) return count(value);
  if (applicability === 'not_applicable') return 'Not applicable';
  return count(value);
}

function browserVisitorReason(product: Product): string | null {
  if (product.browser_visitors !== null || product.browser_visitors_applicability !== 'applicable')
    return null;
  switch (product.browser_visitors_unknown_reason) {
    case 'source_query_unavailable':
      return 'Visitor source query unavailable';
    case 'no_production_environment':
      return 'No production environment';
    case 'sampled_visitor_group':
      return 'Visitor group was sampled';
    case 'telemetry_started_partway_through_day':
      return 'Telemetry began partway through the day';
    case 'telemetry_started_after_day':
      return 'Telemetry began after this day';
    case 'no_qualifying_analytics_receipt':
      return 'No qualifying analytics receipt';
    default:
      return null;
  }
}

function previousReportDay(): string {
  return new Date(Date.now() + 330 * 60_000 - 86_400_000).toISOString().slice(0, 10);
}

function nextIndiaDayBoundary(): number {
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  return Date.parse(`${today}T00:00:00Z`) + 86_400_000 - 330 * 60_000;
}

function ReportHeader({
  date,
  onDateChange,
  onRefresh,
  onLatest,
}: {
  date: string;
  onDateChange: (date: string) => void;
  onRefresh: () => void;
  onLatest: () => void;
}): JSX.Element {
  const dayLabel = new Date(`${date}T12:00:00+05:30`).toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });
  return (
    <CardHeader className="gap-4 border-b px-5 py-5 lg:flex-row lg:items-center lg:justify-between">
      <div>
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Completed India day
        </p>
        <CardTitle
          id="daily-engagement-title"
          role="heading"
          aria-level={2}
          className="mt-1 text-lg"
        >
          {dayLabel}
        </CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">
          Independent browser, action, and response signals across the product inventory.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="block text-xs text-muted-foreground">
          Report date
          <Input
            type="date"
            value={date}
            max={previousReportDay()}
            onChange={(event) => onDateChange(event.target.value)}
            className="mt-1 h-10 w-42"
          />
        </label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onLatest}
          aria-label="Show latest completed day"
          className="h-10"
        >
          Latest
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRefresh}
          aria-label="Refresh daily engagement"
          className="h-10"
        >
          <RefreshCw className="size-4" /> Refresh
        </Button>
      </div>
    </CardHeader>
  );
}

type SourceView = 'all' | 'visitors' | 'actions' | 'responses';

function ReportSummary({
  report,
  sourceView,
  onSourceView,
}: {
  report: Report;
  sourceView: SourceView;
  onSourceView: (sourceView: SourceView) => void;
}): JSX.Element {
  const visitors = report.products.filter((row) => row.browser_visitors !== null).length;
  const actions = report.products.filter((row) => row.cta_status === 'measured').length;
  const feedback = report.products.reduce((total, row) => total + (row.feedback_submitted ?? 0), 0);
  const newsletter = report.products.reduce((total, row) => total + (row.newsletter_joins ?? 0), 0);
  const waitlist = report.products.reduce((total, row) => total + (row.waitlist_joins ?? 0), 0);
  const waitlistApplies = report.products.some(
    (row) => row.waitlist_applicability === 'applicable',
  );
  const receipts = feedback + newsletter + waitlist;
  const missingScope = report.product_count !== 55;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant={missingScope ? 'destructive' : 'secondary'}>
          {report.product_count}/55 imported
        </Badge>
        {report.sampled ? <Badge variant="outline">Sampled</Badge> : null}
        <span>Unknown means the source has no verified value for this day.</span>
      </div>
      <div className="grid gap-3 lg:grid-cols-3" aria-label="Daily evidence summary">
        <button
          type="button"
          aria-pressed={sourceView === 'visitors'}
          onClick={() => onSourceView(sourceView === 'visitors' ? 'all' : 'visitors')}
          className="min-h-28 rounded-lg border border-sky-500/20 bg-sky-500/5 p-4 text-left transition-colors hover:bg-sky-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <p className="text-xs font-medium text-muted-foreground">Visited</p>
          <p className="mt-2 text-2xl font-semibold tabular-nums text-sky-600 dark:text-sky-300">
            {visitors}
          </p>
          <p className="text-xs text-muted-foreground">
            {visitors === 1 ? 'product' : 'products'} with browser visitor evidence
          </p>
        </button>
        <button
          type="button"
          aria-pressed={sourceView === 'actions'}
          onClick={() => onSourceView(sourceView === 'actions' ? 'all' : 'actions')}
          className="min-h-28 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4 text-left transition-colors hover:bg-emerald-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <p className="text-xs font-medium text-muted-foreground">Chose an action</p>
          <p className="mt-2 text-2xl font-semibold tabular-nums text-emerald-700 dark:text-emerald-300">
            {actions}
          </p>
          <p className="text-xs text-muted-foreground">
            {actions === 1 ? 'product' : 'products'} with measured primary actions
          </p>
        </button>
        <button
          type="button"
          aria-pressed={sourceView === 'responses'}
          onClick={() => onSourceView(sourceView === 'responses' ? 'all' : 'responses')}
          className="min-h-28 rounded-lg border border-amber-500/20 bg-amber-500/5 p-4 text-left transition-colors hover:bg-amber-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <p className="text-xs font-medium text-muted-foreground">Replied or joined</p>
          <p className="mt-2 text-2xl font-semibold tabular-nums text-amber-700 dark:text-amber-300">
            {receipts}
          </p>
          <p className="text-xs text-muted-foreground">
            Observed receipts · Feedback: {feedback} · Newsletter joins: {newsletter} · Waitlist:{' '}
            {waitlistApplies ? waitlist : 'not applicable'}
          </p>
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        Source counts are separate; they are not a conversion funnel. Submission receipts may
        include qualification and QA activity, so they do not establish organic demand.
      </p>
      {missingScope ? (
        <p role="status" className="text-xs text-amber-700 dark:text-amber-300">
          This report cannot show products that have not been imported into App Health.
        </p>
      ) : null}
    </>
  );
}

function ProductActions({
  events,
  status,
}: {
  events: Product['cta_events'];
  status: Product['cta_status'];
}): JSX.Element {
  return events.length ? (
    <ul className="space-y-1 text-xs">
      {events.map((event) => (
        <li key={event.name} className="flex justify-between gap-3">
          <span className="font-mono">{event.name}</span>
          <span className="tabular-nums">
            {event.unique_browsers === null
              ? 'Unknown browsers'
              : `${event.unique_browsers} ${event.unique_browsers === 1 ? 'browser' : 'browsers'}`}
            {' · '}
            {event.estimated ? 'Approx. ' : ''}
            {event.count} {event.count === 1 ? 'action' : 'actions'}
          </span>
        </li>
      ))}
    </ul>
  ) : (
    <span className="text-muted-foreground">
      {status === 'not_applicable' ? 'Not applicable' : 'Unknown'}
    </span>
  );
}

function MobileProductCard({ product }: { product: Product }): JSX.Element {
  const metrics = [
    [
      'Browser visitors',
      captureCount(product.browser_visitors, product.browser_visitors_applicability),
    ],
    ['Feedback', product.feedback_submitted],
    ['Newsletter', captureCount(product.newsletter_joins, product.newsletter_applicability)],
    ['Waitlist', captureCount(product.waitlist_joins, product.waitlist_applicability)],
    [
      'Native sessions',
      captureCount(product.native_sessions, product.native_sessions_applicability),
    ],
    ['Server requests', captureCount(product.api_activity, product.server_requests_applicability)],
  ] as const;
  return (
    <li className="rounded-lg border p-4">
      <p className="font-medium">{product.name}</p>
      <p className="text-xs text-muted-foreground">{product.catalog_id}</p>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
        {metrics.map(([label, value]) => (
          <div key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="mt-0.5 font-medium tabular-nums">{count(value)}</dd>
            {label === 'Browser visitors' && browserVisitorReason(product) ? (
              <dd className="mt-1 text-muted-foreground">{browserVisitorReason(product)}</dd>
            ) : null}
          </div>
        ))}
      </dl>
      <div className="mt-3 border-t pt-3 text-xs">
        <p className="text-muted-foreground">Primary actions</p>
        <div className="mt-1">
          <ProductActions events={product.cta_events} status={product.cta_status} />
        </div>
      </div>
    </li>
  );
}

function MobileProducts({ products }: { products: Product[] }): JSX.Element {
  return (
    <ul className="space-y-3 xl:hidden" aria-label="Daily engagement products">
      {products.map((product) => (
        <MobileProductCard key={product.catalog_id} product={product} />
      ))}
    </ul>
  );
}

function DesktopProducts({ products }: { products: Product[] }): JSX.Element {
  return (
    <div className="hidden max-w-full rounded-md border xl:block">
      <p className="border-b px-3 py-2 text-xs text-muted-foreground">
        Scroll horizontally to view all report sources.
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="whitespace-normal">Product</TableHead>
            <TableHead className="whitespace-normal">Visits</TableHead>
            <TableHead className="whitespace-normal">Primary actions</TableHead>
            <TableHead className="whitespace-normal">Responses</TableHead>
            <TableHead className="whitespace-normal text-right">Server requests</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {products.map((product) => (
            <TableRow key={product.catalog_id}>
              <TableCell>
                <span className="font-medium">{product.name}</span>
                <span className="block text-xs text-muted-foreground">{product.catalog_id}</span>
              </TableCell>
              <TableCell className="min-w-40">
                <dl className="space-y-1.5 text-xs">
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Browser visitors</dt>
                    <dd className="shrink-0 text-right tabular-nums">
                      {captureCount(
                        product.browser_visitors,
                        product.browser_visitors_applicability,
                      )}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Native sessions</dt>
                    <dd className="shrink-0 text-right tabular-nums">
                      {captureCount(product.native_sessions, product.native_sessions_applicability)}
                    </dd>
                  </div>
                </dl>
                {browserVisitorReason(product) ? (
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {browserVisitorReason(product)}
                  </span>
                ) : null}
              </TableCell>
              <TableCell className="min-w-52">
                <ProductActions events={product.cta_events} status={product.cta_status} />
              </TableCell>
              <TableCell>
                <dl className="space-y-1.5 text-xs">
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Feedback</dt>
                    <dd className="shrink-0 text-right tabular-nums">
                      {count(product.feedback_submitted)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Newsletter</dt>
                    <dd className="shrink-0 text-right tabular-nums">
                      {captureCount(product.newsletter_joins, product.newsletter_applicability)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Waitlist</dt>
                    <dd className="shrink-0 text-right tabular-nums">
                      {captureCount(product.waitlist_joins, product.waitlist_applicability)}
                    </dd>
                  </div>
                </dl>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {captureCount(product.api_activity, product.server_requests_applicability)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {!products.length ? (
        <p className="p-6 text-center text-sm text-muted-foreground">
          No products match this search.
        </p>
      ) : null}
    </div>
  );
}

function EmptyMobileProducts(): JSX.Element {
  return (
    <p className="rounded-md border p-6 text-center text-sm text-muted-foreground xl:hidden">
      No products match this search.
    </p>
  );
}

function ReportNotes({ report }: { report: Report }): JSX.Element {
  return (
    <div className="space-y-1 text-xs leading-5 text-muted-foreground">
      <p className="flex items-center gap-1.5">
        <CalendarDays className="size-3.5" /> {report.date} {report.timezone} · Unknown means this
        source was not verified for that product and day.
      </p>
      {report.notes.map((note) => (
        <p key={note}>{note}</p>
      ))}
    </div>
  );
}

function ReportResults({
  report,
  query,
  onQueryChange,
  sourceView,
  onSourceView,
}: {
  report: Report;
  query: string;
  onQueryChange: (query: string) => void;
  sourceView: SourceView;
  onSourceView: (sourceView: SourceView) => void;
}): JSX.Element {
  const products = useMemo(
    () =>
      report.products.filter((product) => {
        const matchesSearch = `${product.name} ${product.catalog_id}`
          .toLowerCase()
          .includes(query.trim().toLowerCase());
        if (!matchesSearch) return false;
        if (sourceView === 'visitors') return product.browser_visitors !== null;
        if (sourceView === 'actions') return product.cta_status === 'measured';
        if (sourceView === 'responses')
          return (
            (product.feedback_submitted ?? 0) > 0 ||
            (product.newsletter_joins ?? 0) > 0 ||
            (product.waitlist_joins ?? 0) > 0
          );
        return true;
      }),
    [report, query, sourceView],
  );
  const sourceViewLabel = {
    all: 'all products',
    visitors: 'products with browser visitor evidence',
    actions: 'products with measured primary actions',
    responses: 'products with stored response receipts',
  }[sourceView];
  return (
    <>
      <ReportSummary report={report} sourceView={sourceView} onSourceView={onSourceView} />
      <div
        id="daily-product-evidence"
        className="flex flex-wrap items-center justify-between gap-2 scroll-mt-24"
      >
        <p className="text-xs text-muted-foreground" aria-live="polite">
          Showing {products.length} of {report.product_count} {sourceViewLabel}
          {sourceView !== 'all' ? ' · Unknown sources remain in the full inventory.' : ''}
        </p>
        {sourceView !== 'all' ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              onQueryChange('');
              onSourceView('all');
            }}
          >
            Show all products
          </Button>
        ) : null}
      </div>
      <label className="relative block max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" />
        <span className="sr-only">Search daily report products</span>
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search products"
          className="pl-9"
        />
      </label>
      <MobileProducts products={products} />
      <DesktopProducts products={products} />
      {!products.length ? <EmptyMobileProducts /> : null}
      <ReportNotes report={report} />
    </>
  );
}

function ReportBody({
  loading,
  error,
  report,
  query,
  onQueryChange,
  sourceView,
  onSourceView,
}: {
  loading: boolean;
  error: string;
  report: Report | null;
  query: string;
  onQueryChange: (query: string) => void;
  sourceView: SourceView;
  onSourceView: (sourceView: SourceView) => void;
}): JSX.Element | null {
  if (loading)
    return (
      <div role="status" aria-label="Loading daily engagement" className="space-y-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  if (error)
    return (
      <div role="alert" className="flex items-start gap-2 text-sm text-destructive">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {error}
      </div>
    );
  return report ? (
    <ReportResults
      report={report}
      query={query}
      onQueryChange={onQueryChange}
      sourceView={sourceView}
      onSourceView={onSourceView}
    />
  ) : null;
}

export function DailyEngagement({
  ownerToken,
  onReport,
}: {
  ownerToken: string;
  onReport?: (report: Report | null) => void;
}): JSX.Element {
  const [date, setDate] = useState(previousReportDay);
  const [followsLatest, setFollowsLatest] = useState(true);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState('');
  const [sourceView, setSourceView] = useState<SourceView>('all');

  const selectSourceView = (next: SourceView) => {
    setSourceView(next);
    if (next === 'all') return;
    window.requestAnimationFrame?.(() => {
      document.getElementById('daily-product-evidence')?.scrollIntoView({
        block: 'start',
        behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
          ? 'auto'
          : 'smooth',
      });
    });
  };

  useEffect(() => {
    if (!followsLatest) return;
    const syncDate = () => setDate(previousReportDay());
    let timer: ReturnType<typeof setTimeout>;
    const scheduleBoundary = () => {
      timer = setTimeout(
        () => {
          syncDate();
          scheduleBoundary();
        },
        Math.max(0, nextIndiaDayBoundary() - Date.now() + 25),
      );
    };
    const onFocus = () => syncDate();
    scheduleBoundary();
    window.addEventListener('focus', onFocus);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [followsLatest]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    onReport?.(null);
    const url = `/v1/reports/daily-engagement?date=${encodeURIComponent(date)}&capture_applicability=1&browser_visitor_unknown_reason=1`;
    void fetch(url, {
      signal: controller.signal,
      headers: ownerToken ? { authorization: `Bearer ${ownerToken}` } : {},
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Daily report returned ${response.status}`);
        return DailyEngagementReportV1.parse(await response.json());
      })
      .then((next) => {
        if (!controller.signal.aborted) {
          setReport(next);
          onReport?.(next);
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Daily report is unavailable');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [date, ownerToken, onReport, retry]);

  return (
    <Card
      id="daily-engagement"
      aria-labelledby="daily-engagement-title"
      className="gap-0 py-0 shadow-none"
    >
      <ReportHeader
        date={date}
        onDateChange={(nextDate) => {
          setFollowsLatest(false);
          setDate(nextDate);
        }}
        onLatest={() => {
          setFollowsLatest(true);
          setDate(previousReportDay());
        }}
        onRefresh={() => setRetry((value) => value + 1)}
      />
      <CardContent className="space-y-4 p-5">
        <ReportBody
          loading={loading}
          error={error}
          report={report}
          query={query}
          onQueryChange={setQuery}
          sourceView={sourceView}
          onSourceView={selectSourceView}
        />
      </CardContent>
    </Card>
  );
}
