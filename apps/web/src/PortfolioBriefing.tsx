import {
  PortfolioBriefingV1,
  type DailyEngagementReportV1,
  type PortfolioBriefingV1 as PortfolioBriefingData,
} from '@app-health/contracts';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowUpDown, ExternalLink, RefreshCw, Search, Signal } from 'lucide-react';
import { Badge } from './components/ui/badge.js';
import { Button } from './components/ui/button.js';
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

type DailyProduct = DailyEngagementReportV1['products'][number];
type ProductFocus = 'analytics' | 'events' | 'backend';
type ScopeFilter = 'all' | 'browser' | 'attention';
type SortKey = 'browser' | 'change' | 'actions' | 'pageviews' | 'responses';

export interface PortfolioAttentionItem {
  app_id: string;
  name: string;
  label: string;
  p95_ms: number | null;
  error_rate: number | null;
  report_scoped?: boolean;
}

export interface PortfolioHealthState {
  label: string;
  tone: 'healthy' | 'attention' | 'muted';
}

export interface PortfolioHealthCoverage {
  measured: number;
  applicable: number;
  total: number;
}

interface PortfolioBriefingProps {
  ownerToken: string;
  date: string;
  report: DailyEngagementReportV1;
  onOpenProduct?: (appId: string, focus?: ProductFocus, source?: string, date?: string) => void;
  attentionItems?: PortfolioAttentionItem[];
  healthCoverage?: PortfolioHealthCoverage;
  projectHealth?: Record<string, PortfolioHealthState>;
}

function formatNumber(value: number | null): string {
  return value === null ? 'Unknown' : value.toLocaleString();
}

function applicableCount(
  value: number | null,
  applicability: 'applicable' | 'not_applicable' | 'unknown',
): string {
  if (value !== null) return formatNumber(value);
  return applicability === 'not_applicable' ? 'Not applicable' : 'Unknown';
}

function browserVisitorReason(product: DailyProduct): string | null {
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

function sourceLabel(source: string): string {
  const normalized = source.toLocaleLowerCase();
  if (['google', 'google.com', 'www.google.com'].includes(normalized)) return 'Google';
  if (['bing', 'bing.com', 'www.bing.com'].includes(normalized)) return 'Bing';
  if (['github', 'github.com', 'www.github.com'].includes(normalized)) return 'GitHub';
  return source;
}

function signedNumber(value: number | null): string {
  if (value === null) return 'Not comparable';
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toLocaleString()}`;
}

function responseCount(product: DailyProduct): number | null {
  const values: Array<number | null> = [
    product.feedback_submitted,
    product.newsletter_applicability === 'applicable' ? product.newsletter_joins : null,
    product.waitlist_applicability === 'applicable' ? product.waitlist_joins : null,
  ];
  return values.some((value) => value !== null)
    ? values.reduce<number>((total, value) => total + (value ?? 0), 0)
    : null;
}

function displayResponse(product: DailyProduct): string {
  return formatNumber(responseCount(product));
}

function actionCount(product: DailyProduct): number {
  return product.cta_events.reduce((total, event) => total + event.count, 0);
}

function ActionDetails({ events }: { events: DailyProduct['cta_events'] }): JSX.Element | null {
  if (!events.length) return null;
  return (
    <details className="mt-1 text-xs">
      <summary className="min-h-11 cursor-pointer content-center text-[11px] text-muted-foreground">
        Actions and browsers
      </summary>
      <ul className="space-y-3 pb-2">
        {events.map((event) => (
          <li key={event.name}>
            <span className="block break-all font-mono">{event.name}</span>
            <span className="block text-muted-foreground">
              {event.estimated ? 'Approx. ' : ''}
              {formatNumber(event.count)} events ·{' '}
              {event.unique_browsers === null
                ? 'Browser count unavailable'
                : `${formatNumber(event.unique_browsers)} ${event.unique_browsers === 1 ? 'browser' : 'browsers'}`}
            </span>
          </li>
        ))}
      </ul>
      <p className="pb-2 text-muted-foreground">Browser counts are per action and can overlap.</p>
    </details>
  );
}

function healthLabel(
  appId: string,
  projectHealth: Record<string, PortfolioHealthState> | undefined,
  attentionItems: PortfolioAttentionItem[],
): PortfolioHealthState {
  const state = projectHealth?.[appId];
  if (state) return state;
  const attention = attentionItems.find((item) => item.app_id === appId);
  return attention
    ? { label: attention.label, tone: 'attention' }
    : { label: 'Unknown', tone: 'muted' };
}

function usePortfolioBriefing(ownerToken: string, date: string) {
  const [data, setData] = useState<PortfolioBriefingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let timedOut = false;
    setData(null);
    setLoading(true);
    setError('');
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      if (!disposed) {
        setError('Portfolio sources timed out. Retry to load them.');
        setLoading(false);
      }
    }, 10_000);

    void fetch(`/v1/reports/portfolio-briefing?date=${encodeURIComponent(date)}`, {
      signal: controller.signal,
      headers: ownerToken ? { authorization: `Bearer ${ownerToken}` } : {},
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Portfolio sources returned ${response.status}`);
        return PortfolioBriefingV1.parse(await response.json());
      })
      .then((next) => {
        if (!disposed) setData(next);
      })
      .catch((cause: unknown) => {
        if (!disposed && !controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Portfolio sources are unavailable');
        else if (!disposed && timedOut)
          setError('Portfolio sources timed out. Retry to load them.');
      })
      .finally(() => {
        clearTimeout(timeout);
        if (!disposed) setLoading(false);
      });

    return () => {
      disposed = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [date, ownerToken, retry]);

  return { data, loading, error, retry: () => setRetry((value) => value + 1) };
}

function Stat({
  label,
  value,
  detail,
  className = '',
}: {
  label: string;
  value: string;
  detail: string;
  tone?: 'neutral' | 'sky' | 'green' | 'amber';
  className?: string;
}): JSX.Element {
  return (
    <div className={`min-w-0 rounded-lg border bg-card p-4 ${className}`}>
      <p className="text-[11px] font-medium tracking-[0.03em] text-muted-foreground">{label}</p>
      <p
        className={`mt-3 break-words font-medium tabular-nums text-foreground ${
          value.length > 12
            ? 'text-xl leading-tight tracking-tight'
            : 'text-[clamp(1.65rem,3vw,2.45rem)] leading-none tracking-[-0.055em]'
        }`}
      >
        {value}
      </p>
      <p className="mt-2 text-[11px] leading-[1.5] text-muted-foreground">{detail}</p>
    </div>
  );
}

function BreakoutCard({
  item,
  currentBrowsers,
  onOpen,
}: {
  item: PortfolioBriefingData['products'][number];
  currentBrowsers: number | null;
  onOpen: () => void;
}): JSX.Element {
  const source = item.sources_status === 'measured' ? item.top_sources[0] : undefined;
  const tone = item.browser_change !== null && item.browser_change < 0 ? 'amber' : 'green';
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group min-h-32 border-t border-border bg-transparent py-4 text-left transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex items-center justify-between gap-3">
        <Badge
          variant="outline"
          className={`rounded-full px-2.5 ${
            tone === 'green'
              ? 'border-emerald-500/30 text-emerald-700 dark:text-emerald-300'
              : 'border-amber-500/30 text-amber-700 dark:text-amber-300'
          }`}
        >
          {tone === 'green' ? 'Growth' : 'Down'}
        </Badge>
        <ExternalLink className="size-3.5 text-muted-foreground opacity-70 transition-opacity group-hover:opacity-100" />
      </span>
      <span className="mt-4 block truncate text-lg font-medium tracking-tight text-foreground">
        {item.name}
      </span>
      <span className="mt-1 block text-sm font-medium tabular-nums text-foreground">
        {item.previous_browser_visitors === null
          ? `${formatNumber(item.pageviews)} pageviews`
          : `${formatNumber(currentBrowsers)} browsers · ${signedNumber(item.browser_change)}`}
      </span>
      <span className="mt-1 block truncate text-xs text-muted-foreground">
        {source
          ? `${sourceLabel(source.name)} led · ${Math.round(source.share * 100)}% of pageviews`
          : item.comparison_reason}
      </span>
    </button>
  );
}

function BreakoutCards({
  items,
  report,
  onOpen,
}: {
  items: PortfolioBriefingData['products'];
  report: DailyEngagementReportV1;
  onOpen: (appId: string, focus: ProductFocus, source?: string) => void;
}): JSX.Element {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {items.map((item) => (
        <BreakoutCard
          key={item.app_id}
          item={item}
          currentBrowsers={
            report.products.find((product) => product.app_id === item.app_id)?.browser_visitors ??
            null
          }
          onOpen={() =>
            onOpen(
              item.app_id,
              'analytics',
              item.top_sources[0]?.name === 'Other referral'
                ? undefined
                : item.top_sources[0]?.name,
            )
          }
        />
      ))}
    </div>
  );
}

function HealthCallout({
  item,
  coverage,
  onOpen,
}: {
  item: PortfolioAttentionItem | undefined;
  coverage: PortfolioHealthCoverage | undefined;
  onOpen: () => void;
}): JSX.Element | null {
  if (!item) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex min-h-16 w-full items-center justify-between gap-4 rounded-xl border border-amber-500/25 bg-amber-500/[0.055] px-4 py-3 text-left transition-colors hover:bg-amber-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex min-w-0 items-start gap-3">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-300" />
        <span className="min-w-0">
          <span className="block text-sm font-semibold">
            {item.name}: {item.label}
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {item.report_scoped === false ? 'Outside daily report scope · ' : ''}
            {item.p95_ms === null ? 'Latency unknown' : `p95 ${item.p95_ms.toLocaleString()} ms`}
            {item.error_rate === null
              ? ''
              : ` · ${(item.error_rate * 100).toFixed(1)}% request errors`}
            {coverage
              ? ` · report coverage ${coverage.measured}/${coverage.applicable} measured`
              : ''}
          </span>
        </span>
      </span>
      <span className="hidden shrink-0 items-center gap-1 text-xs font-medium text-amber-800 dark:text-amber-200 sm:flex">
        Open Backend <ExternalLink className="size-3.5" />
      </span>
    </button>
  );
}

function SourcesPanel({
  data,
  onSelectSource,
}: {
  data: PortfolioBriefingData | null;
  onSelectSource: (source: string) => void;
}): JSX.Element {
  const sources = data?.sources ?? [];
  return (
    <section
      aria-labelledby="briefing-sources-title"
      className="border-t-2 border-foreground/15 pt-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id="briefing-sources-title" className="text-sm font-semibold tracking-tight">
            Where traffic came from
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">Share of measured pageviews</p>
        </div>
        <Signal className="size-4 text-muted-foreground" />
      </div>
      {sources.length ? (
        <ol className="mt-4 space-y-3">
          {sources.slice(0, 5).map((source) => (
            <li key={source.name}>
              <SourceButton
                source={source.name}
                date={data?.date}
                intent="filter"
                onOpen={() => onSelectSource(source.name)}
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-3 text-xs">
                    <span className="truncate font-medium">{sourceLabel(source.name)}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {formatNumber(source.pageviews)} · {Math.round(source.share * 100)}%
                    </span>
                  </span>
                  <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-muted">
                    <span
                      className="block h-full rounded-full bg-sky-500/70"
                      style={{ width: `${Math.min(100, Math.max(0, source.share * 100))}%` }}
                    />
                  </span>
                </span>
              </SourceButton>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-4 rounded-lg bg-muted/50 px-3 py-4 text-xs leading-5 text-muted-foreground">
          {data?.filter_note ?? 'Source breakdown is unavailable for this selected day.'}
        </p>
      )}
      <p className="mt-3 border-t pt-3 text-[11px] leading-4 text-muted-foreground">
        Sources use recorded referrer data. “No referrer” is kept as a source; no platform is
        inferred. Select one to filter projects below.
      </p>
    </section>
  );
}

function SourceButton({
  source,
  date,
  onOpen,
  intent = 'open',
  children,
}: {
  source: string;
  date: string | undefined;
  onOpen: () => void;
  intent?: 'open' | 'filter';
  children: ReactNode;
}): JSX.Element {
  if (source === 'Other referral')
    return <div className="flex min-h-11 items-center gap-3 text-left">{children}</div>;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex min-h-11 w-full items-center gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`${intent === 'filter' ? 'Filter projects by' : 'Open'} ${sourceLabel(source)} source for ${date ?? 'selected day'}`}
    >
      {children}
    </button>
  );
}

function valueForSort(
  product: DailyProduct,
  row: PortfolioBriefingData['products'][number] | undefined,
  key: SortKey,
): number | null {
  if (key === 'browser') return product.browser_visitors;
  if (key === 'change') return row?.browser_change ?? null;
  if (key === 'actions') return product.cta_status === 'measured' ? actionCount(product) : null;
  if (key === 'pageviews') return row?.pageviews ?? null;
  return responseCount(product);
}

function SortButton({
  label,
  active,
  direction,
  onClick,
}: {
  label: string;
  active: boolean;
  direction: 'asc' | 'desc';
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex min-h-11 items-center gap-1.5 rounded px-1 text-left font-medium hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`Sort by ${label}${active ? `, ${direction === 'asc' ? 'ascending' : 'descending'}` : ''}`}
    >
      {label}
      <ArrowUpDown className={`size-3.5 ${active ? 'text-foreground' : 'text-muted-foreground'}`} />
    </button>
  );
}

function ProductLedger({
  report,
  data,
  attentionItems,
  projectHealth,
  query,
  setQuery,
  sourceFilter,
  setSourceFilter,
  onOpenProduct,
}: {
  report: DailyEngagementReportV1;
  data: PortfolioBriefingData | null;
  attentionItems: PortfolioAttentionItem[];
  projectHealth?: Record<string, PortfolioHealthState>;
  query: string;
  setQuery: (value: string) => void;
  sourceFilter: string | null;
  setSourceFilter: (value: string | null) => void;
  onOpenProduct?: PortfolioBriefingProps['onOpenProduct'];
}): JSX.Element {
  const [filter, setFilter] = useState<ScopeFilter>('all');
  const [sortKey, setSortKey] = useState<SortKey>('browser');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const byApp = useMemo(
    () => new Map(data?.products.map((item) => [item.app_id, item]) ?? []),
    [data],
  );
  const attentionIds = useMemo(
    () => new Set(attentionItems.map((item) => item.app_id)),
    [attentionItems],
  );
  const products = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return report.products
      .filter((product) => {
        if (!`${product.name} ${product.catalog_id}`.toLocaleLowerCase().includes(normalizedQuery))
          return false;
        if (filter === 'browser') return product.browser_visitors !== null;
        if (filter === 'attention') return attentionIds.has(product.app_id);
        if (
          sourceFilter &&
          !byApp.get(product.app_id)?.top_sources.some((source) => source.name === sourceFilter)
        )
          return false;
        return true;
      })
      .sort((left, right) => {
        const l = valueForSort(left, byApp.get(left.app_id), sortKey);
        const r = valueForSort(right, byApp.get(right.app_id), sortKey);
        if (l === null && r !== null) return 1;
        if (l !== null && r === null) return -1;
        if (l !== null && r !== null && l !== r)
          return (l - r) * (sortDirection === 'asc' ? 1 : -1);
        return left.name.localeCompare(right.name);
      });
  }, [report, byApp, attentionIds, filter, query, sourceFilter, sortDirection, sortKey]);

  const changeSort = (key: SortKey) => {
    if (sortKey === key) setSortDirection((direction) => (direction === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDirection('desc');
    }
  };
  const rowData = (product: DailyProduct) => byApp.get(product.app_id);
  const openProduct = (product: DailyProduct, source?: string) =>
    onOpenProduct?.(product.app_id, 'analytics', source, data?.date ?? report.date);

  const filterButtons: { id: ScopeFilter; label: string; count: number }[] = [
    { id: 'all', label: 'All', count: report.products.length },
    {
      id: 'browser',
      label: 'With browser data',
      count: report.products.filter((product) => product.browser_visitors !== null).length,
    },
    { id: 'attention', label: 'Needs attention', count: attentionItems.length },
  ];

  return (
    <section aria-labelledby="briefing-ledger-title" className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 id="briefing-ledger-title" className="text-lg font-semibold tracking-tight">
              Every project
            </h2>
            <Badge variant="secondary">{report.product_count} in scope</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Browser counts describe recognized browsers by product, not people.
          </p>
        </div>
        <label className="relative block w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" />
          <span className="sr-only">Search projects</span>
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search projects"
            className="h-11 pl-9"
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-2" aria-label="Filter projects">
        {filterButtons.map((option) => (
          <Button
            key={option.id}
            type="button"
            variant={filter === option.id ? 'secondary' : 'outline'}
            className="min-h-11"
            aria-pressed={filter === option.id}
            onClick={() => {
              setFilter(option.id);
              setSourceFilter(null);
            }}
          >
            {option.label}
            <span className="ml-1 tabular-nums text-muted-foreground">{option.count}</span>
          </Button>
        ))}
        <p className="self-center text-xs text-muted-foreground">
          Filters show evidence coverage; all products stay in scope.
        </p>
      </div>
      {sourceFilter ? (
        <div className="flex flex-wrap items-center gap-2 text-xs" role="status">
          <span>
            Showing projects where <strong>{sourceLabel(sourceFilter)}</strong> is a leading source.
          </span>
          <Button
            type="button"
            variant="ghost"
            className="min-h-11"
            onClick={() => setSourceFilter(null)}
          >
            Clear source filter
          </Button>
        </div>
      ) : null}

      <div className="hidden overflow-hidden rounded-xl border border-border/70 bg-card lg:block">
        <Table className="w-full min-w-0 table-fixed">
          <TableHeader className="bg-muted/35">
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[15%]">Project</TableHead>
              <TableHead className="w-[10%]">
                <SortButton
                  label="Browsers"
                  active={sortKey === 'browser'}
                  direction={sortDirection}
                  onClick={() => changeSort('browser')}
                />
              </TableHead>
              <TableHead className="w-[8%]">
                <SortButton
                  label="Change"
                  active={sortKey === 'change'}
                  direction={sortDirection}
                  onClick={() => changeSort('change')}
                />
              </TableHead>
              <TableHead className="w-[16%]">
                <SortButton
                  label="Actions"
                  active={sortKey === 'actions'}
                  direction={sortDirection}
                  onClick={() => changeSort('actions')}
                />
              </TableHead>
              <TableHead className="w-[13%]">Top source</TableHead>
              <TableHead className="w-[10%]">
                <SortButton
                  label="Responses"
                  active={sortKey === 'responses'}
                  direction={sortDirection}
                  onClick={() => changeSort('responses')}
                />
              </TableHead>
              <TableHead className="w-[10%]">Health</TableHead>
              <TableHead className="w-[10%] text-right">
                <SortButton
                  label="Views"
                  active={sortKey === 'pageviews'}
                  direction={sortDirection}
                  onClick={() => changeSort('pageviews')}
                />
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {products.map((product) => {
              const item = rowData(product);
              const source = item?.sources_status === 'measured' ? item.top_sources[0] : undefined;
              const health = healthLabel(product.app_id, projectHealth, attentionItems);
              const actionValue =
                product.cta_status === 'not_applicable'
                  ? 'Not applicable'
                  : product.cta_status === 'measured'
                    ? `${product.cta_events.some((event) => event.estimated) ? 'Approx. ' : ''}${formatNumber(actionCount(product))} events`
                    : 'Unknown';
              return (
                <TableRow key={product.app_id} className="border-border/60">
                  <TableCell className="whitespace-normal">
                    <button
                      type="button"
                      onClick={() => openProduct(product)}
                      className="min-h-11 rounded text-left font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {product.name}
                      <span className="block text-xs font-normal text-muted-foreground">
                        {product.catalog_id}
                      </span>
                    </button>
                  </TableCell>
                  <TableCell className="whitespace-normal tabular-nums">
                    {applicableCount(
                      product.browser_visitors,
                      product.browser_visitors_applicability,
                    )}
                    {browserVisitorReason(product) ? (
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {browserVisitorReason(product)}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-normal break-words tabular-nums">
                    {item?.browser_change === null || item?.browser_change === undefined ? (
                      <span
                        title={item?.comparison_reason ?? 'Comparison unavailable'}
                        className="text-muted-foreground"
                      >
                        Not comparable
                      </span>
                    ) : (
                      <span
                        className={
                          item.browser_change > 0
                            ? 'text-emerald-700 dark:text-emerald-300'
                            : item.browser_change < 0
                              ? 'text-amber-700 dark:text-amber-300'
                              : 'text-muted-foreground'
                        }
                      >
                        {signedNumber(item.browser_change)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-normal text-xs">
                    {actionValue}
                    <ActionDetails events={product.cta_events} />
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {source ? (
                      <SourceButton
                        source={source.name}
                        date={data?.date}
                        onOpen={() => openProduct(product, source.name)}
                      >
                        <span className="min-w-0">
                          <span className="block break-words text-sm">
                            {sourceLabel(source.name)}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {Math.round(source.share * 100)}% of pageviews
                          </span>
                        </span>
                      </SourceButton>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {item?.sources_status === 'not_applicable' ? 'Not applicable' : 'Unknown'}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-normal tabular-nums">
                    {displayResponse(product)}
                    <details className="mt-1 text-[11px]">
                      <summary className="min-h-9 cursor-pointer text-muted-foreground">
                        Details
                      </summary>
                      <dl className="grid gap-1 pb-2">
                        <Metric label="Feedback" value={formatNumber(product.feedback_submitted)} />
                        <Metric
                          label="Newsletter"
                          value={applicableCount(
                            product.newsletter_joins,
                            product.newsletter_applicability,
                          )}
                        />
                        <Metric
                          label="Waitlist"
                          value={applicableCount(
                            product.waitlist_joins,
                            product.waitlist_applicability,
                          )}
                        />
                      </dl>
                    </details>
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <HealthBadge state={health} />
                    <details className="mt-1 text-[11px]">
                      <summary className="min-h-9 cursor-pointer text-muted-foreground">
                        More
                      </summary>
                      <dl className="grid gap-1 pb-2">
                        <Metric
                          label="Native sessions"
                          value={applicableCount(
                            product.native_sessions,
                            product.native_sessions_applicability,
                          )}
                        />
                        <Metric
                          label="Server requests"
                          value={applicableCount(
                            product.api_activity,
                            product.server_requests_applicability,
                          )}
                        />
                      </dl>
                    </details>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(item?.pageviews ?? null)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {!products.length ? (
          <p className="p-8 text-center text-sm text-muted-foreground">
            No projects match this filter.
          </p>
        ) : null}
      </div>

      <ul className="space-y-2 lg:hidden" aria-label="Portfolio project ledger">
        {products.map((product) => {
          const item = rowData(product);
          const source = item?.sources_status === 'measured' ? item.top_sources[0] : undefined;
          const health = healthLabel(product.app_id, projectHealth, attentionItems);
          return (
            <li key={product.app_id} className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-3">
                <button
                  type="button"
                  onClick={() => openProduct(product)}
                  className="min-h-11 min-w-0 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="block truncate font-semibold">{product.name}</span>
                  <span className="block text-xs text-muted-foreground">{product.catalog_id}</span>
                </button>
                <HealthBadge state={health} />
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 border-t pt-3 text-xs">
                <Metric
                  label="Browsers"
                  value={applicableCount(
                    product.browser_visitors,
                    product.browser_visitors_applicability,
                  )}
                />
                <Metric
                  label="Change"
                  value={item ? signedNumber(item.browser_change) : 'Unknown'}
                />
                <Metric
                  label="Actions"
                  value={
                    product.cta_status === 'measured'
                      ? `${product.cta_events.some((event) => event.estimated) ? 'Approx. ' : ''}${formatNumber(actionCount(product))}`
                      : product.cta_status === 'not_applicable'
                        ? 'Not applicable'
                        : 'Unknown'
                  }
                />
                <Metric label="Replies + joins" value={displayResponse(product)} />
                <Metric label="Pageviews" value={formatNumber(item?.pageviews ?? null)} />
                <div>
                  <dt className="text-muted-foreground">Leading source</dt>
                  <dd className="mt-0.5 font-medium">
                    {source ? (
                      <SourceButton
                        source={source.name}
                        date={data?.date}
                        onOpen={() => openProduct(product, source.name)}
                      >
                        {sourceLabel(source.name)} · {Math.round(source.share * 100)}%
                      </SourceButton>
                    ) : item?.sources_status === 'not_applicable' ? (
                      'Not applicable'
                    ) : (
                      'Unknown'
                    )}
                  </dd>
                </div>
              </dl>
              <ActionDetails events={product.cta_events} />
              <details className="mt-2 border-t pt-2 text-xs">
                <summary className="min-h-11 cursor-pointer content-center font-medium text-muted-foreground">
                  Native and server activity
                </summary>
                <dl className="grid grid-cols-2 gap-3 pb-1">
                  <Metric
                    label="Native sessions"
                    value={applicableCount(
                      product.native_sessions,
                      product.native_sessions_applicability,
                    )}
                  />
                  <Metric
                    label="Server requests"
                    value={applicableCount(
                      product.api_activity,
                      product.server_requests_applicability,
                    )}
                  />
                </dl>
              </details>
            </li>
          );
        })}
      </ul>
      {!products.length ? (
        <p className="rounded-xl border p-8 text-center text-sm text-muted-foreground lg:hidden">
          No projects match this filter.
        </p>
      ) : null}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function HealthBadge({ state }: { state: PortfolioHealthState }): JSX.Element {
  const className =
    state.tone === 'attention'
      ? 'border-amber-500/30 text-amber-800 dark:text-amber-200'
      : state.tone === 'healthy'
        ? 'border-emerald-500/30 text-emerald-800 dark:text-emerald-200'
        : 'text-muted-foreground';
  return (
    <Badge variant="outline" className={className}>
      {state.label}
    </Badge>
  );
}

function Summary({
  report,
  data,
  attentionItems,
  healthCoverage,
}: {
  report: DailyEngagementReportV1;
  data: PortfolioBriefingData | null;
  attentionItems: PortfolioAttentionItem[];
  healthCoverage?: PortfolioHealthCoverage;
}): JSX.Element {
  const pageviews = data?.products.reduce((total, row) => total + (row.pageviews ?? 0), 0) ?? null;
  const pageviewProducts = data?.products.filter((row) => row.pageviews !== null).length ?? 0;
  const browserProducts = report.products.filter(
    (product) => product.browser_visitors !== null,
  ).length;
  const browserCounts = report.products.reduce(
    (total, product) => total + (product.browser_visitors ?? 0),
    0,
  );
  const measuredActionProducts = report.products.filter(
    (product) => product.cta_status === 'measured',
  ).length;
  const namedActionCount = report.products.reduce(
    (total, product) => total + actionCount(product),
    0,
  );
  const actionEstimated = report.products.some((product) =>
    product.cta_events.some((event) => event.estimated),
  );
  const downloadIntentEvents = report.products
    .flatMap((product) => product.cta_events)
    .filter((event) => event.name.toLocaleLowerCase().includes('download'));
  const downloadIntent = downloadIntentEvents.reduce((total, event) => total + event.count, 0);
  const downloadIsApproximate = downloadIntentEvents.some((event) => event.estimated);
  const responses = report.products.reduce(
    (total, product) => total + (responseCount(product) ?? 0),
    0,
  );
  const responseProducts = report.products.filter(
    (product) => responseCount(product) !== null,
  ).length;
  const responsesUnknown = report.products.some((product) => responseCount(product) === null);
  const pageviewsEstimated =
    data?.products.some((row) => row.pageviews !== null && row.source_estimated) ?? false;
  const reportAttentionItems = attentionItems.filter((item) => item.report_scoped !== false);
  const outsideReportIssues = attentionItems.filter((item) => item.report_scoped === false);
  const outsideReportDetail = outsideReportIssues.length
    ? ` · ${outsideReportIssues.length} issue${outsideReportIssues.length === 1 ? '' : 's'} outside report scope`
    : '';
  const healthValue = !healthCoverage
    ? 'Unknown'
    : reportAttentionItems.length
      ? reportAttentionItems.length.toLocaleString()
      : healthCoverage.applicable > 0 && healthCoverage.measured === 0
        ? 'Unknown'
        : healthCoverage.applicable === 0
          ? 'Not applicable'
          : 'No measured issues';
  const healthDetail = healthCoverage
    ? `${healthCoverage.measured}/${healthCoverage.applicable} applicable measured · ${healthCoverage.total} report products · latest 24 hours${outsideReportDetail}`
    : 'Coverage unknown · latest 24 hours';
  const downloadValue = downloadIntentEvents.length
    ? `${downloadIsApproximate ? '≈ ' : ''}${downloadIntent.toLocaleString()}`
    : 'Unknown';

  return (
    <section aria-label="Selected day summary" className="space-y-4">
      <div className="grid grid-cols-2 gap-x-5 sm:grid-cols-3 xl:grid-cols-6">
        <Stat
          label="Known browser counts"
          value={browserProducts ? browserCounts.toLocaleString() : 'Unknown'}
          detail={`${browserProducts} products with reportable counts · scopes may overlap`}
          tone="sky"
        />
        <Stat
          label="Browser pageviews"
          value={data && pageviewProducts ? formatNumber(pageviews) : 'Unknown'}
          detail={
            data
              ? `${pageviewProducts} products with source data${pageviewsEstimated ? ' · estimated' : ''}`
              : 'Source aggregate unavailable'
          }
        />
        <Stat
          label="Primary action events"
          value={
            measuredActionProducts
              ? `${actionEstimated ? '≈ ' : ''}${namedActionCount.toLocaleString()}`
              : 'Unknown'
          }
          detail={`${measuredActionProducts} products with measured actions · events, not people`}
          tone="green"
        />
        <Stat
          label="Download intent"
          value={downloadValue}
          detail={`${downloadIntentEvents.length ? `${downloadIntentEvents.length} named event${downloadIntentEvents.length === 1 ? '' : 's'}` : 'No named download event'} · clicks, not completions`}
          tone="green"
        />
        <Stat
          label="Confirmed responses"
          value={responseProducts ? responses.toLocaleString() : 'Unknown'}
          detail={`${responseProducts} products with reported counts${responsesUnknown ? ' · partial coverage' : ''} · QA may be included`}
        />
        <Stat
          label="Measured health issues"
          value={healthValue}
          detail={healthDetail}
          tone={attentionItems.length ? 'amber' : 'neutral'}
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-3 text-[11px] text-muted-foreground">
        <span>{report.product_count}/55 products in scope</span>
        <span aria-hidden="true">·</span>
        <span>{browserProducts} products with reportable browser counts</span>
        <span aria-hidden="true">·</span>
        <span>Browser counts are product-scoped, not portfolio-wide unique browsers</span>
        {report.sampled ? <Badge variant="outline">Some sources sampled</Badge> : null}
      </div>
      <details className="text-xs text-muted-foreground">
        <summary className="min-h-11 cursor-pointer py-2 font-medium">Action coverage</summary>
        <p className="pb-3">
          Named action events:{' '}
          {measuredActionProducts
            ? `${actionEstimated ? 'approximately ' : ''}${namedActionCount.toLocaleString()}`
            : 'Unknown'}{' '}
          across {measuredActionProducts} products. These count instrumented clicks; download intent
          above is one subset, not completed work.
        </p>
      </details>
    </section>
  );
}

export function PortfolioBriefing(props: PortfolioBriefingProps): JSX.Element {
  const {
    ownerToken,
    date,
    report,
    onOpenProduct,
    attentionItems = [],
    healthCoverage,
    projectHealth,
  } = props;
  const { data, loading, error, retry } = usePortfolioBriefing(ownerToken, date);
  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const [showAllBreakouts, setShowAllBreakouts] = useState(false);
  const breakoutItems = useMemo(
    () => (data?.products ?? []).filter((product) => product.breakout),
    [data],
  );
  const attention =
    attentionItems.find((item) => item.report_scoped !== false) ?? attentionItems[0];
  const comparisonHint = data?.comparison_note ?? 'Comparison details are unavailable.';
  const open = (appId: string, focus: ProductFocus, source?: string) =>
    onOpenProduct?.(appId, focus, source, data?.date ?? date);

  return (
    <div className="space-y-8 sm:space-y-10">
      <Summary
        report={report}
        data={data}
        attentionItems={attentionItems}
        healthCoverage={healthCoverage}
      />

      <div className="grid gap-8 xl:grid-cols-[minmax(0,1.55fr)_minmax(280px,0.75fr)]">
        <section aria-labelledby="briefing-movement-title" className="space-y-3">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h2 id="briefing-movement-title" className="text-lg font-semibold tracking-tight">
                What moved
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Breakouts appear only when the prior day is comparable.
              </p>
            </div>
            {loading ? (
              <span className="text-xs text-muted-foreground">Loading sources…</span>
            ) : null}
          </div>
          {error ? (
            <div
              role="status"
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/20 bg-amber-500/[0.04] px-4 py-3 text-xs"
            >
              <span className="text-muted-foreground">
                Sources and comparisons unavailable. The daily report is still available.
              </span>
              <Button type="button" variant="outline" className="min-h-11" onClick={retry}>
                <RefreshCw className="size-4" />
                Retry insights
              </Button>
            </div>
          ) : null}
          {!data && loading ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Skeleton className="h-32 rounded-xl" />
              <Skeleton className="h-32 rounded-xl" />
            </div>
          ) : null}
          {data ? (
            breakoutItems.length ? (
              <div className="space-y-3">
                <BreakoutCards
                  items={showAllBreakouts ? breakoutItems : breakoutItems.slice(0, 2)}
                  report={report}
                  onOpen={open}
                />
                {breakoutItems.length > 2 ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    onClick={() => setShowAllBreakouts((value) => !value)}
                  >
                    {showAllBreakouts
                      ? 'Show the top two'
                      : `Show all ${breakoutItems.length} breakouts`}
                  </Button>
                ) : null}
              </div>
            ) : (
              <div className="border-l-2 border-border py-2 pl-4">
                <p className="text-sm font-medium">No comparable breakouts for this day</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{comparisonHint}</p>
              </div>
            )
          ) : null}
          <HealthCallout
            item={attention}
            coverage={healthCoverage}
            onOpen={() => open(attention?.app_id ?? '', 'backend')}
          />
        </section>
        <SourcesPanel
          data={data}
          onSelectSource={(source) => {
            setSourceFilter(source);
            setQuery('');
          }}
        />
      </div>

      <ProductLedger
        report={report}
        data={data}
        attentionItems={attentionItems}
        projectHealth={projectHealth}
        query={query}
        setQuery={setQuery}
        sourceFilter={sourceFilter}
        setSourceFilter={setSourceFilter}
        onOpenProduct={onOpenProduct}
      />

      <div className="flex flex-wrap gap-x-2 gap-y-1 border-t pt-3 text-[11px] leading-4 text-muted-foreground">
        <span>
          {data?.date ?? report.date} · {report.timezone}
        </span>
        <span>Unknown is not zero.</span>
        {data?.filter_note ? <span>{data.filter_note}</span> : null}
      </div>
      <details className="text-xs text-muted-foreground">
        <summary className="min-h-11 cursor-pointer py-3 font-medium">
          How to read this report
        </summary>
        <ul className="list-disc space-y-1 pl-5 pb-3">
          {report.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}
