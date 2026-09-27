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

function count(value: number | null): string {
  return value === null ? 'Unknown' : value.toLocaleString();
}

function previousReportDay(): string {
  return new Date(Date.now() + 330 * 60_000 - 86_400_000).toISOString().slice(0, 10);
}

export function DailyEngagement({ ownerToken }: { ownerToken: string }): JSX.Element {
  const [date, setDate] = useState(previousReportDay);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const url = `/v1/reports/daily-engagement?date=${encodeURIComponent(date)}`;
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

  const rows = useMemo(
    () =>
      (report?.products ?? []).filter((product) =>
        `${product.name} ${product.catalog_id}`.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    [report, query],
  );
  const knownVisitors = report?.products.filter((row) => row.browser_visitors !== null).length ?? 0;
  const knownFeedback =
    report?.products.filter((row) => row.feedback_submitted !== null).length ?? 0;
  const hasMissingScope = Boolean(report && report.product_count !== 55);

  return (
    <Card
      id="daily-engagement"
      aria-labelledby="daily-engagement-title"
      className="gap-0 py-0 shadow-none"
    >
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
            Browser visitors, chosen actions, feedback, and consented joins across the imported
            portfolio.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="block text-xs text-muted-foreground">
            Report date
            <Input
              type="date"
              value={date}
              max={previousReportDay()}
              onChange={(event) => setDate(event.target.value)}
              className="mt-1 h-10 w-42"
            />
          </label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setRetry((value) => value + 1)}
            aria-label="Refresh daily engagement"
            className="h-10"
          >
            <RefreshCw className="size-4" /> Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 p-5">
        {loading ? (
          <div role="status" aria-label="Loading daily engagement" className="space-y-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        ) : error ? (
          <div role="alert" className="flex items-start gap-2 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {error}
          </div>
        ) : report ? (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant={hasMissingScope ? 'destructive' : 'secondary'}>
                {report.product_count}/55 imported
              </Badge>
              <span>{knownVisitors} with visitor evidence</span>
              <span aria-hidden="true">·</span>
              <span>{knownFeedback} with submission evidence</span>
              {report.sampled ? <Badge variant="outline">Sampled</Badge> : null}
            </div>
            {hasMissingScope ? (
              <p role="status" className="text-xs text-amber-700 dark:text-amber-300">
                This report cannot show products that have not been imported into App Health.
              </p>
            ) : null}
            <label className="relative block max-w-sm">
              <Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" />
              <span className="sr-only">Search daily report products</span>
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search products"
                className="pl-9"
              />
            </label>
            <ul className="space-y-3 md:hidden" aria-label="Daily engagement products">
              {rows.map((row) => (
                <li key={row.catalog_id} className="rounded-lg border p-4">
                  <p className="font-medium">{row.name}</p>
                  <p className="text-xs text-muted-foreground">{row.catalog_id}</p>
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
                    <div>
                      <dt className="text-muted-foreground">Visitors</dt>
                      <dd className="mt-0.5 font-medium tabular-nums">
                        {count(row.browser_visitors)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Feedback</dt>
                      <dd className="mt-0.5 font-medium tabular-nums">
                        {count(row.feedback_submitted)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Newsletter</dt>
                      <dd className="mt-0.5 font-medium tabular-nums">
                        {count(row.newsletter_joins)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Waitlist</dt>
                      <dd className="mt-0.5 font-medium tabular-nums">
                        {count(row.waitlist_joins)}
                      </dd>
                    </div>
                  </dl>
                  <div className="mt-3 border-t pt-3 text-xs">
                    <p className="text-muted-foreground">Primary actions</p>
                    {row.cta_events.length ? (
                      <ul className="mt-1 space-y-1">
                        {row.cta_events.map((event) => (
                          <li key={event.name} className="flex justify-between gap-2">
                            <span className="font-mono">{event.name}</span>
                            <span className="tabular-nums">{event.count}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-1 text-muted-foreground">Unknown</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <div className="hidden max-w-full overflow-x-auto rounded-md border md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Visitors</TableHead>
                    <TableHead>Primary actions</TableHead>
                    <TableHead className="text-right">Feedback</TableHead>
                    <TableHead className="text-right">Newsletter</TableHead>
                    <TableHead className="text-right">Waitlist</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.catalog_id}>
                      <TableCell>
                        <span className="font-medium">{row.name}</span>
                        <span className="block text-xs text-muted-foreground">
                          {row.catalog_id}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {count(row.browser_visitors)}
                      </TableCell>
                      <TableCell className="min-w-52">
                        {row.cta_events.length ? (
                          <ul className="space-y-1 text-xs">
                            {row.cta_events.map((event) => (
                              <li key={event.name} className="flex justify-between gap-3">
                                <span className="font-mono">{event.name}</span>
                                <span className="tabular-nums">{event.count}</span>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <span className="text-muted-foreground">Unknown</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {count(row.feedback_submitted)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {count(row.newsletter_joins)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {count(row.waitlist_joins)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {!rows.length ? (
                <p className="p-6 text-center text-sm text-muted-foreground">
                  No products match this search.
                </p>
              ) : null}
            </div>
            {!rows.length ? (
              <p className="rounded-md border p-6 text-center text-sm text-muted-foreground md:hidden">
                No products match this search.
              </p>
            ) : null}
            <div className="space-y-1 text-xs leading-5 text-muted-foreground">
              <p className="flex items-center gap-1.5">
                <CalendarDays className="size-3.5" /> {report.date} {report.timezone} · Unknown
                means this source was not verified for that product and day.
              </p>
              {report.notes.map((note) => (
                <p key={note}>{note}</p>
              ))}
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
