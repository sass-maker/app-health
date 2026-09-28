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
  applicability: Product['newsletter_applicability'],
): string {
  if (value !== null && value > 0) return count(value);
  if (applicability === 'not_applicable') return 'Not applicable';
  return count(value);
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
          Daily engagement
        </CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">
          Recognized browser visitors, native sessions, server requests, chosen actions, feedback,
          and consented joins across the imported portfolio. Requests are not people.
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

function ReportSummary({ report }: { report: Report }): JSX.Element {
  const visitors = report.products.filter((row) => row.browser_visitors !== null).length;
  const feedback = report.products.filter((row) => row.feedback_submitted !== null).length;
  const missingScope = report.product_count !== 55;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant={missingScope ? 'destructive' : 'secondary'}>
          {report.product_count}/55 imported
        </Badge>
        <span>{visitors} with browser visitor evidence</span>
        <span aria-hidden="true">·</span>
        <span>{feedback} with submission evidence</span>
        {report.sampled ? <Badge variant="outline">Sampled</Badge> : null}
      </div>
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
            {event.count} actions
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
    ['Browser visitors', product.browser_visitors],
    ['Native sessions', product.native_sessions],
    ['Server requests', product.api_activity],
    ['Feedback', product.feedback_submitted],
    ['Newsletter', captureCount(product.newsletter_joins, product.newsletter_applicability)],
    ['Waitlist', captureCount(product.waitlist_joins, product.waitlist_applicability)],
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
    <ul className="space-y-3 md:hidden" aria-label="Daily engagement products">
      {products.map((product) => (
        <MobileProductCard key={product.catalog_id} product={product} />
      ))}
    </ul>
  );
}

function DesktopProducts({ products }: { products: Product[] }): JSX.Element {
  return (
    <div className="hidden max-w-full overflow-x-auto rounded-md border md:block">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Product</TableHead>
            <TableHead className="text-right">Browser visitors</TableHead>
            <TableHead className="text-right">Native sessions</TableHead>
            <TableHead className="text-right">Server requests</TableHead>
            <TableHead>Primary actions</TableHead>
            <TableHead className="text-right">Feedback</TableHead>
            <TableHead className="text-right">Newsletter</TableHead>
            <TableHead className="text-right">Waitlist</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {products.map((product) => (
            <TableRow key={product.catalog_id}>
              <TableCell>
                <span className="font-medium">{product.name}</span>
                <span className="block text-xs text-muted-foreground">{product.catalog_id}</span>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {count(product.browser_visitors)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {count(product.native_sessions)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {count(product.api_activity)}
              </TableCell>
              <TableCell className="min-w-52">
                <ProductActions events={product.cta_events} status={product.cta_status} />
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {count(product.feedback_submitted)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {captureCount(product.newsletter_joins, product.newsletter_applicability)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {captureCount(product.waitlist_joins, product.waitlist_applicability)}
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
    <p className="rounded-md border p-6 text-center text-sm text-muted-foreground md:hidden">
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
}: {
  report: Report;
  query: string;
  onQueryChange: (query: string) => void;
}): JSX.Element {
  const products = useMemo(
    () =>
      report.products.filter((product) =>
        `${product.name} ${product.catalog_id}`.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    [report, query],
  );
  return (
    <>
      <ReportSummary report={report} />
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
}: {
  loading: boolean;
  error: string;
  report: Report | null;
  query: string;
  onQueryChange: (query: string) => void;
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
    <ReportResults report={report} query={query} onQueryChange={onQueryChange} />
  ) : null;
}

export function DailyEngagement({ ownerToken }: { ownerToken: string }): JSX.Element {
  const [date, setDate] = useState(previousReportDay);
  const [followsLatest, setFollowsLatest] = useState(true);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState('');

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
    const url = `/v1/reports/daily-engagement?date=${encodeURIComponent(date)}&capture_applicability=1`;
    void fetch(url, {
      signal: controller.signal,
      headers: ownerToken ? { authorization: `Bearer ${ownerToken}` } : {},
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Daily report returned ${response.status}`);
        return DailyEngagementReportV1.parse(await response.json());
      })
      .then((next) => {
        if (!controller.signal.aborted) setReport(next);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Daily report is unavailable');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [date, ownerToken, retry]);

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
        />
      </CardContent>
    </Card>
  );
}
