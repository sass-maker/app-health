import {
  CatalogImportRequestV1,
  MAX_PORTFOLIO_CATALOG_PRODUCTS,
  PortfolioBriefingV1,
  type BriefingTraffic,
  type DailyEngagementReportV1,
  type PortfolioBriefingV1 as PortfolioBriefingData,
} from '@app-health/contracts';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type ReactElement,
} from 'react';
import { useResource } from '@saas-maker/ui/lib/use-resource';
import { accountResourceClient } from './lib/account-resource-client.js';
import { ownerFetch } from './lib/owner-fetch.js';
import {
  AlertTriangle,
  ArrowUpDown,
  Download,
  ExternalLink,
  LoaderCircle,
  Search,
  Signal,
  X,
} from 'lucide-react';
import { Badge } from '@saas-maker/ui/components/badge';
import { Button } from '@saas-maker/ui/components/button';
import { Input } from '@saas-maker/ui/components/input';
import { DataTable, type DataColumn } from './components/ResourceTable.js';
import { FilterBar } from '@saas-maker/ui/blocks/filter-bar';
import { EmptyState } from '@saas-maker/ui/components/empty-state';
import { ErrorState } from '@saas-maker/ui/components/error-state';
import { CardSkeleton } from '@saas-maker/ui/blocks/skeletons';
import { Skeleton } from '@saas-maker/ui/components/skeleton';
import {
  createPortfolioUsageExport,
  type PortfolioUsageProject,
} from './lib/portfolio-usage-export.js';

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
  projects: PortfolioUsageProject[];
  date: string;
  report: DailyEngagementReportV1;
  onOpenProduct?: (appId: string, focus?: ProductFocus, source?: string, date?: string) => void;
  attentionItems?: PortfolioAttentionItem[];
  healthCoverage?: PortfolioHealthCoverage;
  projectHealth?: Record<string, PortfolioHealthState>;
  onCatalogLinked?: () => void;
}

const TRAFFIC_OPTIONS: { id: BriefingTraffic; label: string }[] = [
  { id: 'non_bot', label: 'non-bot' },
  { id: 'bots', label: 'bots' },
  { id: 'all', label: 'all' },
];

const NOT_RETAINED = 'not retained';

/** Bot counters keep pageviews by source only; browser and action metrics are non-bot. */
function nonBotMetric(traffic: BriefingTraffic, value: string): string {
  return traffic === 'bots' ? NOT_RETAINED : value;
}

function TrafficSelector({
  traffic,
  onChange,
}: {
  traffic: BriefingTraffic;
  onChange: (traffic: BriefingTraffic) => void;
}): ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div role="group" aria-label="Traffic">
        <FilterBar>
          {TRAFFIC_OPTIONS.map((option) => (
            <Button
              key={option.id}
              type="button"
              variant={traffic === option.id ? 'secondary' : 'outline'}
              className="min-h-11"
              aria-pressed={traffic === option.id}
              onClick={() => onChange(option.id)}
            >
              {option.label}
            </Button>
          ))}
        </FilterBar>
      </div>
      <p className="text-xs text-muted-foreground">
        {traffic === 'non_bot'
          ? 'known bots excluded; unrecognized automation can remain.'
          : 'pageviews and sources include known bots. browsers and actions stay non-bot only.'}
      </p>
    </div>
  );
}

function confirmedCatalogLink(value: unknown, catalogId: string, appId: string): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const response = value as { schema_version?: unknown; projects?: unknown };
  if (response.schema_version !== 1 || !Array.isArray(response.projects)) return false;
  if (response.projects.length !== 1) return false;
  const project = response.projects[0];
  if (typeof project !== 'object' || project === null) return false;
  const record = project as {
    catalog_id?: unknown;
    app_id?: unknown;
    verification_state?: unknown;
  };
  return (
    record.catalog_id === catalogId &&
    record.app_id === appId &&
    record.verification_state === 'declared'
  );
}

function CatalogLinkForm({
  ownerToken,
  projects,
  catalogCount,
  linked,
}: {
  ownerToken: string;
  projects: PortfolioUsageProject[];
  catalogCount: number | null;
  linked: () => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [declared, setDeclared] = useState(false);
  const [message, setMessage] = useState('');
  const submitLock = useRef(false);
  const requestController = useRef<AbortController | null>(null);
  const capacityAvailable = catalogCount !== null && catalogCount < MAX_PORTFOLIO_CATALOG_PRODUCTS;
  useEffect(() => () => requestController.current?.abort(), [ownerToken]);
  const existingProjects = useMemo(
    () =>
      [
        ...new Map(
          projects
            .filter((project) => project.environment === 'production')
            .map((project) => [project.appId, project]),
        ).values(),
      ].sort((left, right) => left.name.localeCompare(right.name)),
    [projects],
  );

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitLock.current || declared) return;
    if (!capacityAvailable) {
      setMessage(
        catalogCount === null
          ? 'The linked catalog count is unavailable; refresh the report before adding a link.'
          : 'The reporting catalog is at capacity. No link was added.',
      );
      return;
    }
    submitLock.current = true;
    setSaving(true);
    setMessage('');
    const controller = new AbortController();
    requestController.current = controller;
    const form = new FormData(event.currentTarget);
    try {
      const request = CatalogImportRequestV1.parse({
        schema_version: 1,
        projects: [
          {
            catalog_id: String(form.get('catalog_id') ?? '').trim(),
            name: String(form.get('name') ?? '').trim(),
            lifecycle: 'active',
            repository: String(form.get('repository') ?? '').trim() || null,
            hostname: String(form.get('hostname') ?? '').trim() || null,
            existing_app_id: String(form.get('existing_app_id') ?? ''),
          },
        ],
      });
      const response = await ownerFetch('/v1/catalog/import', ownerToken, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify(request),
      });
      if (controller.signal.aborted) return;
      if (response.status === 409) {
        setMessage(
          'This catalog ID or App Health project is already linked and cannot be changed.',
        );
        return;
      }
      if (!response.ok) {
        setMessage(
          `Catalog link was not saved (HTTP ${response.status}). Your entries are still here.`,
        );
        return;
      }
      let confirmation: unknown;
      try {
        confirmation = await response.json();
      } catch {
        setMessage(
          'The server did not return a valid link confirmation. Your entries are still here.',
        );
        return;
      }
      if (controller.signal.aborted) return;
      if (
        !confirmedCatalogLink(
          confirmation,
          request.projects[0]!.catalog_id,
          request.projects[0]!.existing_app_id!,
        )
      ) {
        setMessage(
          'The server did not confirm this exact catalog link. Your entries are still here.',
        );
        return;
      }
      setDeclared(true);
      setMessage('Catalog link declared. This does not verify tracking or meaningful product use.');
      linked();
    } catch (error) {
      if (!controller.signal.aborted)
        setMessage(
          error instanceof Error
            ? error.message
            : 'Catalog link failed. Your entries are still here.',
        );
    } finally {
      submitLock.current = false;
      if (requestController.current === controller) requestController.current = null;
      if (!controller.signal.aborted) setSaving(false);
    }
  }

  return (
    <div className="w-full">
      <Button
        type="button"
        variant="ghost"
        className="min-h-11"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {open ? 'close catalog link' : 'link existing project'}
      </Button>
      {open ? (
        <form
          onSubmit={(event) => void submit(event)}
          className="mt-3 grid gap-3 rounded-lg border border-border/70 bg-background/50 p-3 sm:grid-cols-2"
        >
          <p className="text-xs leading-5 text-muted-foreground sm:col-span-2">
            Link a canonical catalog ID to an existing production project in this workspace. This is
            an immutable declaration; it does not create a project, change keys, or verify
            ownership, tracking, or product use. The portfolio supports up to{' '}
            {MAX_PORTFOLIO_CATALOG_PRODUCTS} linked projects.
          </p>
          {!capacityAvailable ? (
            <p role="status" className="text-xs text-muted-foreground sm:col-span-2">
              {catalogCount === null
                ? 'Linked catalog count is unavailable; refresh the report before adding a link.'
                : 'The reporting catalog is at capacity. No link was added.'}
            </p>
          ) : null}
          <label className="grid gap-1 text-xs text-muted-foreground">
            existing production project
            <select
              name="existing_app_id"
              required
              defaultValue=""
              disabled={saving || declared}
              className="min-h-11 rounded-md border border-input bg-background px-3 text-sm text-foreground"
            >
              <option value="" disabled>
                select an existing project
              </option>
              {existingProjects.map((project) => (
                <option key={project.appId} value={project.appId}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            canonical catalog ID
            <Input
              name="catalog_id"
              required
              pattern="[a-z0-9][a-z0-9-]{0,99}"
              maxLength={100}
              disabled={saving || declared}
              className="min-h-11"
            />
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            canonical name
            <Input
              name="name"
              required
              maxLength={100}
              disabled={saving || declared}
              className="min-h-11"
            />
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            public GitHub repository (optional)
            <Input
              name="repository"
              type="url"
              placeholder="https://github.com/owner/repository"
              disabled={saving || declared}
              className="min-h-11"
            />
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            public hostname (optional)
            <Input
              name="hostname"
              placeholder="example.com"
              disabled={saving || declared}
              className="min-h-11"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            <Button
              type="submit"
              variant="outline"
              className="min-h-11"
              disabled={saving || declared || existingProjects.length === 0 || !capacityAvailable}
            >
              {saving ? 'linking project' : declared ? 'link declared' : 'declare catalog link'}
            </Button>
            {message ? (
              <p role="status" className="text-xs text-muted-foreground">
                {message}
              </p>
            ) : null}
          </div>
        </form>
      ) : null}
    </div>
  );
}

function formatNumber(value: number | null): string {
  return value === null ? 'unknown' : value.toLocaleString();
}

function applicableCount(
  value: number | null,
  applicability: 'applicable' | 'not_applicable' | 'unknown',
): string {
  if (applicability === 'not_applicable' && (value === null || value === 0))
    return 'not applicable';
  return formatNumber(value);
}

function browserVisitorReason(product: DailyProduct): string | null {
  if (product.browser_visitors !== null || product.browser_visitors_applicability !== 'applicable')
    return null;
  switch (product.browser_visitors_unknown_reason) {
    case 'source_query_unavailable':
      return 'visitor source query unavailable';
    case 'no_production_environment':
      return 'no production environment';
    case 'sampled_visitor_group':
      return 'visitor group was sampled';
    case 'telemetry_started_partway_through_day':
      return 'telemetry began partway through the day';
    case 'telemetry_started_after_day':
      return 'telemetry began after this day';
    case 'no_qualifying_analytics_receipt':
      return 'no qualifying analytics receipt';
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
  if (value === null) return 'not comparable';
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

function responseNotApplicable(product: DailyProduct): boolean {
  return (
    product.feedback_applicability === 'not_applicable' &&
    product.newsletter_applicability === 'not_applicable' &&
    product.waitlist_applicability === 'not_applicable'
  );
}

function displayResponse(product: DailyProduct): string {
  return applicableCount(
    responseCount(product),
    responseNotApplicable(product) ? 'not_applicable' : 'unknown',
  );
}

function actionCount(product: DailyProduct): number {
  return product.cta_events.reduce((total, event) => total + event.count, 0);
}

function ActionDetails({ events }: { events: DailyProduct['cta_events'] }): ReactElement | null {
  if (!events.length) return null;
  return (
    <details className="mt-1 text-xs">
      <summary className="min-h-11 cursor-pointer content-center text-[11px] text-muted-foreground">
        actions and browsers
      </summary>
      <ul className="space-y-3 pb-2">
        {events.map((event) => (
          <li key={event.name}>
            <span className="block break-all font-mono">{event.name}</span>
            <span className="block text-muted-foreground">
              {event.estimated ? 'approx. ' : ''}
              {formatNumber(event.count)} events ·{' '}
              {event.unique_browsers === null
                ? 'browser count unavailable'
                : `${formatNumber(event.unique_browsers)} ${event.unique_browsers === 1 ? 'browser' : 'browsers'}`}
            </span>
          </li>
        ))}
      </ul>
      <p className="pb-2 text-muted-foreground">browser counts are per action and can overlap.</p>
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
    : { label: 'unknown', tone: 'muted' };
}

async function fetchPortfolioBriefing(
  ownerToken: string,
  date: string,
  traffic: BriefingTraffic,
  signal: AbortSignal,
): Promise<PortfolioBriefingData> {
  const controller = new AbortController();
  const abort = () => {
    controller.abort();
    clearTimeout(timeout);
  };
  signal.addEventListener('abort', abort, { once: true });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await ownerFetch(
          `/v1/reports/portfolio-briefing?date=${encodeURIComponent(date)}&traffic=${traffic}`,
          ownerToken,
          {
            signal: controller.signal,
            headers: ownerToken ? { authorization: `Bearer ${ownerToken}` } : {},
          },
        );
        if (!response.ok) throw new Error(`portfolio sources returned ${response.status}`);
        return PortfolioBriefingV1.parse(await response.json());
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error('portfolio sources timed out. retry to load them.'));
        }, 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}

function usePortfolioBriefing(ownerToken: string, date: string, traffic: BriefingTraffic) {
  const client = useMemo(() => accountResourceClient(ownerToken), [ownerToken]);
  const resource = useResource(
    `portfolio-briefing:${date}:${traffic}`,
    (signal) => fetchPortfolioBriefing(ownerToken, date, traffic, signal),
    { client, staleTime: 0, retries: 0, revalidateOnFocus: false, revalidateOnReconnect: false },
  );
  return {
    data: resource.data ?? null,
    loading: resource.status === 'loading',
    error: resource.error?.message ?? '',
    retry: () => {
      void resource.retry();
    },
  };
}

function Stat({
  label,
  value,
  detail,
  loading = false,
  className = '',
}: {
  label: string;
  value: string;
  detail: string;
  loading?: boolean;
  tone?: 'neutral' | 'sky' | 'green' | 'amber';
  className?: string;
}): ReactElement {
  return (
    <div className={`min-w-0 rounded-lg border bg-card p-4 ${className}`}>
      <p className="text-[11px] font-medium tracking-[0.03em] text-muted-foreground">{label}</p>
      <div
        className={`mt-3 min-h-10 break-words font-medium tabular-nums text-foreground ${
          !loading && (value.length > 12 || /[a-z]/i.test(value))
            ? 'text-xl leading-tight tracking-tight'
            : 'text-[clamp(1.65rem,3vw,2.45rem)] leading-none tracking-[-0.055em]'
        }`}
      >
        {loading ? (
          <div role="status" aria-label={`Loading ${label}`} aria-busy="true">
            <Skeleton className="h-10 w-16 max-w-full" />
          </div>
        ) : (
          value
        )}
      </div>
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
}): ReactElement {
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
          {tone === 'green' ? 'growth' : 'down'}
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
}): ReactElement {
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
}): ReactElement | null {
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
            {item.report_scoped === false ? 'outside daily report scope · ' : ''}
            {item.p95_ms === null ? 'latency unknown' : `p95 ${item.p95_ms.toLocaleString()} ms`}
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
        open backend <ExternalLink className="size-3.5" />
      </span>
    </button>
  );
}

function SourcesPanel({
  data,
  onSelectSource,
  loading,
}: {
  data: PortfolioBriefingData | null;
  loading: boolean;
  onSelectSource: (source: string) => void;
}): ReactElement {
  const sources = data?.sources ?? [];
  return (
    <section
      aria-labelledby="briefing-sources-title"
      className="border-t-2 border-foreground/15 pt-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id="briefing-sources-title" className="text-sm font-semibold tracking-tight">
            where traffic came from
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">share of measured pageviews</p>
        </div>
        <Signal className="size-4 text-muted-foreground" />
      </div>
      {loading && !data ? (
        <CardSkeleton className="mt-4 min-h-56" />
      ) : sources.length ? (
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
          {data?.filter_note ?? 'source breakdown is unavailable for this selected day.'}
        </p>
      )}
      <p className="mt-3 border-t pt-3 text-[11px] leading-4 text-muted-foreground">
        sources use recorded referrer data. “no referrer” is kept as a source; no platform is
        inferred. select one to filter projects below.
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
}): ReactElement {
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
  traffic: BriefingTraffic,
): number | null {
  if (traffic === 'bots' && (key === 'browser' || key === 'actions')) return null;
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
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex min-h-11 items-center gap-1.5 rounded px-1 text-left font-medium hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`Sort by ${label[0]!.toUpperCase() + label.slice(1)}${active ? `, ${direction === 'asc' ? 'ascending' : 'descending'}` : ''}`}
    >
      {label.toLowerCase()}
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
  traffic,
}: {
  report: DailyEngagementReportV1;
  data: PortfolioBriefingData | null;
  traffic: BriefingTraffic;
  attentionItems: PortfolioAttentionItem[];
  projectHealth?: Record<string, PortfolioHealthState>;
  query: string;
  setQuery: (value: string) => void;
  sourceFilter: string | null;
  setSourceFilter: (value: string | null) => void;
  onOpenProduct?: PortfolioBriefingProps['onOpenProduct'];
}): ReactElement {
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
        const l = valueForSort(left, byApp.get(left.app_id), sortKey, traffic);
        const r = valueForSort(right, byApp.get(right.app_id), sortKey, traffic);
        if (l === null && r !== null) return 1;
        if (l !== null && r === null) return -1;
        if (l !== null && r !== null && l !== r)
          return (l - r) * (sortDirection === 'asc' ? 1 : -1);
        return left.name.localeCompare(right.name);
      });
  }, [report, byApp, attentionIds, filter, query, sourceFilter, sortDirection, sortKey, traffic]);

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

  const renderCells = (product: DailyProduct): ReactNode[] => {
    const item = rowData(product);
    const source = item?.sources_status === 'measured' ? item.top_sources[0] : undefined;
    const health = healthLabel(product.app_id, projectHealth, attentionItems);
    const actionValue =
      traffic === 'bots'
        ? NOT_RETAINED
        : product.cta_status === 'not_applicable'
          ? 'not applicable'
          : product.cta_status === 'measured'
            ? `${product.cta_events.some((event) => event.estimated) ? 'approx. ' : ''}${formatNumber(actionCount(product))} events`
            : 'unknown';
    return [
      <div className="whitespace-normal">
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
      </div>,
      <div className="whitespace-normal tabular-nums">
        {nonBotMetric(
          traffic,
          applicableCount(product.browser_visitors, product.browser_visitors_applicability),
        )}
        {traffic !== 'bots' && browserVisitorReason(product) ? (
          <span className="mt-1 block text-xs text-muted-foreground">
            {browserVisitorReason(product)}
          </span>
        ) : null}
      </div>,
      <div className="whitespace-normal break-words tabular-nums">
        {item?.browser_change === null || item?.browser_change === undefined ? (
          <span
            title={item?.comparison_reason ?? 'comparison unavailable'}
            className="text-muted-foreground"
          >
            not comparable
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
      </div>,
      <div className="whitespace-normal text-xs">
        {actionValue}
        <ActionDetails events={product.cta_events} />
      </div>,
      <div className="whitespace-normal">
        {source ? (
          <SourceButton
            source={source.name}
            date={data?.date}
            onOpen={() => openProduct(product, source.name)}
          >
            <span className="min-w-0">
              <span className="block break-words text-sm">{sourceLabel(source.name)}</span>
              <span className="block text-xs text-muted-foreground">
                {Math.round(source.share * 100)}% of pageviews
              </span>
            </span>
          </SourceButton>
        ) : (
          <span className="text-xs text-muted-foreground">
            {item?.sources_status === 'not_applicable' ? 'not applicable' : 'unknown'}
          </span>
        )}
      </div>,
      <div className="whitespace-normal tabular-nums">
        {displayResponse(product)}
        <details className="mt-1 text-[11px]">
          <summary className="min-h-9 cursor-pointer text-muted-foreground">details</summary>
          <dl className="grid gap-1 pb-2">
            <Metric
              label="feedback"
              value={applicableCount(
                product.feedback_submitted,
                product.feedback_applicability ?? 'unknown',
              )}
            />
            <Metric
              label="newsletter"
              value={applicableCount(product.newsletter_joins, product.newsletter_applicability)}
            />
            <Metric
              label="waitlist"
              value={applicableCount(product.waitlist_joins, product.waitlist_applicability)}
            />
          </dl>
        </details>
      </div>,
      <div className="whitespace-normal">
        <HealthBadge state={health} />
        <details className="mt-1 text-[11px]">
          <summary className="min-h-9 cursor-pointer text-muted-foreground">more</summary>
          <dl className="grid gap-1 pb-2">
            <Metric
              label="native sessions"
              value={applicableCount(
                product.native_sessions,
                product.native_sessions_applicability,
              )}
            />
            <Metric
              label="server requests"
              value={applicableCount(product.api_activity, product.server_requests_applicability)}
            />
          </dl>
        </details>
      </div>,
      <div className="text-right tabular-nums">{formatNumber(item?.pageviews ?? null)}</div>,
    ];
  };
  const columns: DataColumn<DailyProduct>[] = [
    {
      id: 'project',
      header: 'project',
      value: (product) => product.name,
      cell: (product) => renderCells(product)[0],
      sortable: false,
      hideable: false,
      minWidth: '10rem',
    },
    {
      id: 'browser',
      header: 'browsers',
      value: (product) => valueForSort(product, rowData(product), 'browser', traffic),
      cell: (product) => renderCells(product)[1],
      sortable: false,
      hideable: false,
      minWidth: '7rem',
    },
    {
      id: 'change',
      header: 'change',
      value: (product) => valueForSort(product, rowData(product), 'change', traffic),
      cell: (product) => renderCells(product)[2],
      sortable: false,
      hideable: false,
      minWidth: '7rem',
    },
    {
      id: 'actions',
      header: 'actions',
      value: (product) => valueForSort(product, rowData(product), 'actions', traffic),
      cell: (product) => renderCells(product)[3],
      sortable: false,
      hideable: false,
      minWidth: '7rem',
    },
    {
      id: 'source',
      header: 'top source',
      value: () => null,
      cell: (product) => renderCells(product)[4],
      sortable: false,
      hideable: false,
      minWidth: '7rem',
    },
    {
      id: 'responses',
      header: 'responses',
      value: (product) => valueForSort(product, rowData(product), 'responses', traffic),
      cell: (product) => renderCells(product)[5],
      sortable: false,
      hideable: false,
      minWidth: '7rem',
    },
    {
      id: 'health',
      header: 'health',
      value: () => null,
      cell: (product) => renderCells(product)[6],
      sortable: false,
      hideable: false,
      minWidth: '7rem',
    },
    {
      id: 'pageviews',
      header: 'views',
      value: (product) => valueForSort(product, rowData(product), 'pageviews', traffic),
      cell: (product) => renderCells(product)[7],
      sortable: false,
      hideable: false,
      minWidth: '7rem',
    },
  ];
  const filterButtons: { id: ScopeFilter; label: string; count: number }[] = [
    { id: 'all', label: 'all', count: report.products.length },
    {
      id: 'browser',
      label: 'with browser data',
      count: report.products.filter((product) => product.browser_visitors !== null).length,
    },
    { id: 'attention', label: 'needs attention', count: attentionItems.length },
  ];

  return (
    <section aria-labelledby="briefing-ledger-title" className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 id="briefing-ledger-title" className="text-lg font-semibold tracking-tight">
              every project
            </h2>
            <Badge variant="secondary">{report.product_count} in scope</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            browser counts describe recognized browsers by product, not people.
          </p>
        </div>
        <label className="relative block w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" />
          <span className="sr-only">Search projects</span>
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="search projects"
            className="h-11 pl-9"
          />
        </label>
      </div>

      <div aria-label="Filter projects">
        <FilterBar>
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
            filters show evidence coverage; all products stay in scope.
          </p>
        </FilterBar>
      </div>
      {sourceFilter ? (
        <div className="flex flex-wrap items-center gap-2 text-xs" role="status">
          <span>
            showing projects where <strong>{sourceLabel(sourceFilter)}</strong> is a leading source.
          </span>
          <Button
            type="button"
            variant="ghost"
            className="min-h-11"
            onClick={() => setSourceFilter(null)}
          >
            clear source filter
          </Button>
        </div>
      ) : null}

      <div className="hidden lg:block">
        <DataTable
          label="Portfolio project ledger"
          data={products}
          columns={columns}
          getRowId={(product) => product.app_id}
          pageSize={Math.max(1, products.length)}
          maxHeight="none"
          manual={{ rowCount: products.length, page: 0, onPageChange: () => {} }}
          empty={<EmptyState title="no projects match this filter." />}
          toolbar={() => (
            <FilterBar>
              {[
                { id: 'browser' as const, label: 'browsers' },
                { id: 'change' as const, label: 'change' },
                { id: 'actions' as const, label: 'actions' },
                { id: 'responses' as const, label: 'responses' },
                { id: 'pageviews' as const, label: 'views' },
              ].map((column) => (
                <SortButton
                  key={column.id}
                  label={column.label}
                  active={sortKey === column.id}
                  direction={sortDirection}
                  onClick={() => changeSort(column.id)}
                />
              ))}
            </FilterBar>
          )}
        />
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
                  label="browsers"
                  value={nonBotMetric(
                    traffic,
                    applicableCount(
                      product.browser_visitors,
                      product.browser_visitors_applicability,
                    ),
                  )}
                />
                <Metric
                  label="change"
                  value={item ? signedNumber(item.browser_change) : 'unknown'}
                />
                <Metric
                  label="actions"
                  value={
                    traffic === 'bots'
                      ? NOT_RETAINED
                      : product.cta_status === 'measured'
                        ? `${product.cta_events.some((event) => event.estimated) ? 'approx. ' : ''}${formatNumber(actionCount(product))}`
                        : product.cta_status === 'not_applicable'
                          ? 'not applicable'
                          : 'unknown'
                  }
                />
                <Metric label="replies + joins" value={displayResponse(product)} />
                <Metric label="pageviews" value={formatNumber(item?.pageviews ?? null)} />
                <div>
                  <dt className="text-muted-foreground">leading source</dt>
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
                      'not applicable'
                    ) : (
                      'unknown'
                    )}
                  </dd>
                </div>
              </dl>
              <ActionDetails events={product.cta_events} />
              <details className="mt-2 border-t pt-2 text-xs">
                <summary className="min-h-11 cursor-pointer content-center font-medium text-muted-foreground">
                  native and server activity
                </summary>
                <dl className="grid grid-cols-2 gap-3 pb-1">
                  <Metric
                    label="native sessions"
                    value={applicableCount(
                      product.native_sessions,
                      product.native_sessions_applicability,
                    )}
                  />
                  <Metric
                    label="server requests"
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
          no projects match this filter.
        </p>
      ) : null}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function HealthBadge({ state }: { state: PortfolioHealthState }): ReactElement {
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

const BOT_IDENTITY_DETAIL = 'bot counters keep pageviews by source only';
const PAGEVIEW_LABEL: Record<BriefingTraffic, string> = {
  non_bot: 'browser pageviews',
  bots: 'bot pageviews',
  all: 'all pageviews',
};

function Summary({
  report,
  data,
  loading,
  traffic,
  attentionItems,
  healthCoverage,
}: {
  report: DailyEngagementReportV1;
  data: PortfolioBriefingData | null;
  loading: boolean;
  traffic: BriefingTraffic;
  attentionItems: PortfolioAttentionItem[];
  healthCoverage?: PortfolioHealthCoverage;
}): ReactElement {
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
  const responsesUnknown = report.products.some(
    (product) => responseCount(product) === null && !responseNotApplicable(product),
  );
  const pageviewsEstimated =
    data?.products.some((row) => row.pageviews !== null && row.source_estimated) ?? false;
  const nonBotSuffix = traffic === 'all' ? ' · non-bot only' : '';
  const reportAttentionItems = attentionItems.filter((item) => item.report_scoped !== false);
  const outsideReportIssues = attentionItems.filter((item) => item.report_scoped === false);
  const outsideReportDetail = outsideReportIssues.length
    ? ` · ${outsideReportIssues.length} issue${outsideReportIssues.length === 1 ? '' : 's'} outside report scope`
    : '';
  const healthValue = !healthCoverage
    ? 'unknown'
    : reportAttentionItems.length
      ? reportAttentionItems.length.toLocaleString()
      : healthCoverage.applicable > 0 && healthCoverage.measured === 0
        ? 'unknown'
        : healthCoverage.applicable === 0
          ? 'not applicable'
          : 'no measured issues';
  const healthDetail = healthCoverage
    ? `${healthCoverage.measured}/${healthCoverage.applicable} applicable measured · ${healthCoverage.total} report products · latest 24 hours${outsideReportDetail}`
    : 'coverage unknown · latest 24 hours';
  const downloadValue = downloadIntentEvents.length
    ? `${downloadIsApproximate ? '≈ ' : ''}${downloadIntent.toLocaleString()}`
    : 'unknown';

  return (
    <section aria-label="Selected day summary" className="space-y-4">
      <div className="grid grid-cols-2 gap-x-5 sm:grid-cols-3 xl:grid-cols-6">
        <Stat
          label="known browser counts"
          value={nonBotMetric(
            traffic,
            browserProducts ? browserCounts.toLocaleString() : 'unknown',
          )}
          detail={
            traffic === 'bots'
              ? BOT_IDENTITY_DETAIL
              : `${browserProducts} products with reportable counts · scopes may overlap${nonBotSuffix}`
          }
          tone="sky"
        />
        <Stat
          label={PAGEVIEW_LABEL[traffic]}
          value={data && pageviewProducts ? formatNumber(pageviews) : 'unknown'}
          loading={loading && !data}
          detail={
            loading && !data
              ? 'loading selected traffic…'
              : data
                ? `${pageviewProducts} products with source data${pageviewsEstimated ? ' · estimated' : ''}`
                : 'source aggregate unavailable'
          }
        />
        <Stat
          label="primary action events"
          value={nonBotMetric(
            traffic,
            measuredActionProducts
              ? `${actionEstimated ? '≈ ' : ''}${namedActionCount.toLocaleString()}`
              : 'unknown',
          )}
          detail={
            traffic === 'bots'
              ? BOT_IDENTITY_DETAIL
              : `${measuredActionProducts} products with measured actions · events, not people${nonBotSuffix}`
          }
          tone="green"
        />
        <Stat
          label="download intent"
          value={nonBotMetric(traffic, downloadValue)}
          detail={
            traffic === 'bots'
              ? BOT_IDENTITY_DETAIL
              : `${downloadIntentEvents.length ? `${downloadIntentEvents.length} named event${downloadIntentEvents.length === 1 ? '' : 's'}` : 'no named download event'} · clicks, not completions${nonBotSuffix}`
          }
          tone="green"
        />
        <Stat
          label="confirmed responses"
          value={responseProducts ? responses.toLocaleString() : 'unknown'}
          detail={`${responseProducts} products with reported counts${responsesUnknown ? ' · partial coverage' : ''} · QA may be included`}
        />
        <Stat
          label="measured health issues"
          value={healthValue}
          detail={healthDetail}
          tone={attentionItems.length ? 'amber' : 'neutral'}
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-3 text-[11px] text-muted-foreground">
        <span>
          {report.product_count} linked products · capacity {MAX_PORTFOLIO_CATALOG_PRODUCTS}
        </span>
        <span aria-hidden="true">·</span>
        <span>{browserProducts} products with reportable browser counts</span>
        <span aria-hidden="true">·</span>
        <span>browser counts are product-scoped, not portfolio-wide unique browsers</span>
        {report.sampled ? <Badge variant="outline">some sources sampled</Badge> : null}
      </div>
      <details className="text-xs text-muted-foreground">
        <summary className="min-h-11 cursor-pointer py-2 font-medium">action coverage</summary>
        <p className="pb-3">
          named action events:{' '}
          {measuredActionProducts
            ? `${actionEstimated ? 'approximately ' : ''}${namedActionCount.toLocaleString()}`
            : 'unknown'}{' '}
          across {measuredActionProducts} products. these count instrumented clicks; download intent
          above is one subset, not completed work.
        </p>
      </details>
    </section>
  );
}

export function PortfolioBriefing(props: PortfolioBriefingProps): ReactElement {
  const {
    ownerToken,
    projects,
    date,
    report,
    onOpenProduct,
    attentionItems = [],
    healthCoverage,
    projectHealth,
    onCatalogLinked,
  } = props;
  const [traffic, setTraffic] = useState<BriefingTraffic>('non_bot');
  const { data, loading, error, retry } = usePortfolioBriefing(ownerToken, date, traffic);
  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const [showAllBreakouts, setShowAllBreakouts] = useState(false);
  const [exportingUsage, setExportingUsage] = useState(false);
  const [usageExportMessage, setUsageExportMessage] = useState('');
  const usageExportController = useRef<AbortController | null>(null);
  const usageExportLock = useRef(false);
  useEffect(
    () => () => {
      usageExportController.current?.abort();
    },
    [ownerToken],
  );
  const breakoutItems = useMemo(
    () => (data?.products ?? []).filter((product) => product.breakout),
    [data],
  );
  const attention =
    attentionItems.find((item) => item.report_scoped !== false) ?? attentionItems[0];
  const comparisonHint = data?.comparison_note ?? 'comparison details are unavailable.';
  const open = (appId: string, focus: ProductFocus, source?: string) =>
    onOpenProduct?.(appId, focus, source, data?.date ?? date);

  async function exportUsage(): Promise<void> {
    if (usageExportLock.current) return;
    usageExportLock.current = true;
    const controller = new AbortController();
    usageExportController.current = controller;
    setExportingUsage(true);
    setUsageExportMessage('');
    try {
      const result = await createPortfolioUsageExport({
        ownerToken,
        products: report.products.map((product) => ({
          catalog_id: product.catalog_id,
          app_id: product.app_id,
          name: product.name,
          browser_visitors_applicability: product.browser_visitors_applicability,
          browser_visitors_unknown_reason: product.browser_visitors_unknown_reason,
          coverage: product.coverage,
        })),
        projects,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const blob = new Blob([`${JSON.stringify(result, null, 2)}\n`], {
        type: 'application/json',
      });
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = `app-health-portfolio-usage-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
      setUsageExportMessage(
        `Exported ${Object.keys(result.usage.records).length} catalog records. Browser counts are proxies; core use remains unqualified.`,
      );
    } catch (error) {
      if (!controller.signal.aborted) {
        setUsageExportMessage(
          error instanceof Error ? error.message : 'Usage export failed. Please try again.',
        );
      } else {
        setUsageExportMessage('Usage export canceled.');
      }
    } finally {
      if (usageExportController.current === controller) usageExportController.current = null;
      usageExportLock.current = false;
      setExportingUsage(false);
    }
  }

  function cancelUsageExport(): void {
    usageExportController.current?.abort(new DOMException('Export canceled', 'AbortError'));
  }

  return (
    <div className="space-y-8 sm:space-y-10">
      <div className="flex flex-col gap-2 rounded-lg border bg-card/40 p-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs leading-5 text-muted-foreground">
          rolling 30-day aggregate export; recognized browsers are not people, and no core action is
          qualified yet.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <CatalogLinkForm
            key={ownerToken}
            ownerToken={ownerToken}
            projects={projects}
            catalogCount={data?.products.length ?? null}
            linked={() => {
              void retry();
              onCatalogLinked?.();
            }}
          />
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={exportingUsage}
            onClick={() => void exportUsage()}
          >
            {exportingUsage ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Download className="size-4" aria-hidden="true" />
            )}
            {exportingUsage ? 'exporting 30-day usage' : 'export 30-day usage'}
          </Button>
          {exportingUsage ? (
            <Button type="button" variant="ghost" className="min-h-11" onClick={cancelUsageExport}>
              <X className="size-4" aria-hidden="true" /> cancel
            </Button>
          ) : null}
          {usageExportMessage ? (
            <p role="status" className="w-full text-xs text-muted-foreground sm:w-auto">
              {usageExportMessage}
            </p>
          ) : null}
        </div>
      </div>
      <TrafficSelector
        traffic={traffic}
        onChange={(next) => {
          setTraffic(next);
          setSourceFilter(null);
        }}
      />
      <Summary
        report={report}
        data={data}
        loading={loading}
        traffic={traffic}
        attentionItems={attentionItems}
        healthCoverage={healthCoverage}
      />

      <div className="grid gap-8 xl:grid-cols-[minmax(0,1.55fr)_minmax(280px,0.75fr)]">
        <section aria-labelledby="briefing-movement-title" className="space-y-3">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h2 id="briefing-movement-title" className="text-lg font-semibold tracking-tight">
                what moved
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                breakouts appear only when the prior day is comparable.
              </p>
            </div>
          </div>
          {error ? (
            <ErrorState
              title="sources and comparisons unavailable"
              description="the daily report is still available."
              detail={error}
              primaryAction={
                <Button type="button" variant="outline" className="min-h-11" onClick={retry}>
                  retry insights
                </Button>
              }
            />
          ) : null}
          {!data && loading ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <CardSkeleton className="min-h-32" />
              <CardSkeleton className="min-h-32" />
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
                      ? 'show the top two'
                      : `show all ${breakoutItems.length} breakouts`}
                  </Button>
                ) : null}
              </div>
            ) : (
              <div className="border-l-2 border-border py-2 pl-4">
                <p className="text-sm font-medium">no comparable breakouts for this day</p>
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
          loading={loading}
          onSelectSource={(source) => {
            setSourceFilter(source);
            setQuery('');
          }}
        />
      </div>

      <ProductLedger
        report={report}
        data={data}
        traffic={traffic}
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
        <span>unknown is not zero.</span>
        {data?.filter_note ? <span>{data.filter_note}</span> : null}
      </div>
      <details className="text-xs text-muted-foreground">
        <summary className="min-h-11 cursor-pointer py-3 font-medium">
          how to read this report
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
