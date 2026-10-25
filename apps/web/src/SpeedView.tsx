import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { SpeedReportV1, type SpeedReportV1 as Report } from '@app-health/contracts';
import { RefreshCw } from 'lucide-react';
import { FilterBar } from '@saas-maker/ui/blocks/filter-bar';
import { EmptyState } from '@saas-maker/ui/components/empty-state';
import { ErrorState } from '@saas-maker/ui/components/error-state';
import { Button } from '@saas-maker/ui/components/button';
import { Input } from '@saas-maker/ui/components/input';
import { LabeledSelect } from './LabeledSelect.js';
import { SpeedTable, SpeedTableSkeleton } from './SpeedTable.js';
import { apiUrl, ownerFetch } from './lib/owner-fetch.js';
import { pollWhileVisible } from './lib/visible-poll.js';
import { isBreaching, sortSpeedProducts, type SpeedSort } from './lib/speed-display.js';

const reportErrors: Record<number, string> = {
  400: 'invalid speed filters (400). choose a supported range and class, then retry.',
  403: 'workspace owner access required (403). sign in with the workspace owner session.',
  503: 'speed reporting is unavailable (503). the report service is not ready; try again shortly.',
};

// Owner reports stay in memory only, expire after five minutes and never cross sessions.
const reportCache = new Map<string, { report: Report; expires: number }>();

function cachedReport(key: string): Report | null {
  const cached = reportCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.report;
  reportCache.delete(key);
  return null;
}

function rememberReport(key: string, report: Report): void {
  reportCache.set(key, { report, expires: Date.now() + 300_000 });
  if (reportCache.size > 20) reportCache.delete(reportCache.keys().next().value!);
}

function useSpeedReport(
  ownerToken: string,
  range: Report['range'],
  performanceClass: Report['class'],
) {
  const cacheKey = JSON.stringify([ownerToken, range, performanceClass]);
  const [report, setReport] = useState<Report | null>(() => cachedReport(cacheKey));
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let pending = false;
    let controller: AbortController | undefined;
    const cached = cachedReport(cacheKey);
    setReport(cached);
    setError('');
    setLoading(!cached);
    async function load(): Promise<void> {
      if (pending || document.visibilityState === 'hidden') return;
      pending = true;
      controller = new AbortController();
      try {
        const response = await ownerFetch(
          apiUrl(`/v1/reports/speed?range=${range}&class=${performanceClass}`),
          ownerToken,
          { signal: controller.signal },
        );
        if (!response.ok)
          throw new Error(
            reportErrors[response.status] ??
              `speed report returned ${response.status}. please retry.`,
          );
        const parsed = SpeedReportV1.safeParse(await response.json());
        if (
          !parsed.success ||
          parsed.data.range !== range ||
          parsed.data.class !== performanceClass
        )
          throw new Error('invalid speed report response. please retry.');
        if (!cancelled) {
          rememberReport(cacheKey, parsed.data);
          setReport(parsed.data);
          setError('');
        }
      } catch (cause) {
        if (!cancelled)
          setError(
            cause instanceof Error
              ? cause.message
              : 'could not load the speed report. please retry.',
          );
      } finally {
        pending = false;
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    const stop = pollWhileVisible(() => void load(), 60_000);
    return () => {
      cancelled = true;
      controller?.abort();
      stop();
    };
  }, [ownerToken, range, performanceClass, retry, cacheKey]);
  return { report, error, loading, reload: () => setRetry((value) => value + 1) };
}

function EnableSpeedData(): ReactElement {
  return (
    <p className="text-sm leading-6 text-muted-foreground">
      enable tracker <code>data-vitals</code> and server <code>api.stage_timing</code> logs to
      collect samples; see{' '}
      <a
        className="underline underline-offset-4 hover:text-foreground"
        href="https://github.com/sass-maker/app-health/blob/main/docs/performance-contract.md#speed-report"
      >
        docs/performance-contract.md
      </a>
      .
    </p>
  );
}

export function SpeedView({ ownerToken }: { ownerToken: string }): ReactElement {
  const [range, setRange] = useState<Report['range']>('24h');
  const [performanceClass, setClass] = useState<Report['class']>('app');
  const [state, setState] = useState('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SpeedSort>('name');
  const [ascending, setAscending] = useState(true);
  const { report, error, loading, reload } = useSpeedReport(ownerToken, range, performanceClass);
  const products = useMemo(
    () =>
      sortSpeedProducts(
        (report?.products ?? []).filter((product) => {
          const matchesState =
            state === 'all' ||
            (state === 'breaching' ? isBreaching(product) : product.state === state);
          const query = search.trim().toLocaleLowerCase();
          return (
            matchesState &&
            `${product.name} ${product.catalog_id}`.toLocaleLowerCase().includes(query)
          );
        }),
        sort,
        ascending,
      ),
    [report, state, search, sort, ascending],
  );

  return (
    <section id="speed-view" aria-label="Workspace speed" className="min-w-0 space-y-5">
      <div aria-label="Speed filters">
        <FilterBar className="items-end gap-3 border-b pb-5">
          <Filter label="range">
            <LabeledSelect
              label="Speed range"
              value={range}
              options={[
                { value: '1h', label: '1 hour' },
                { value: '24h', label: '24 hours' },
                { value: '7d', label: '7 days' },
              ]}
              onValueChange={(value) => setRange(value as Report['range'])}
              triggerClassName="h-11 w-32"
            />
          </Filter>
          <Filter label="class">
            <LabeledSelect
              label="Performance class"
              value={performanceClass}
              options={[
                { value: 'landing', label: 'landing' },
                { value: 'app', label: 'app' },
                { value: 'api', label: 'API' },
              ]}
              onValueChange={(value) => setClass(value as Report['class'])}
              triggerClassName="h-11 w-32"
            />
          </Filter>
          <Filter label="state">
            <LabeledSelect
              label="Speed state"
              value={state}
              options={[
                { value: 'all', label: 'all' },
                { value: 'breaching', label: 'breaching' },
                { value: 'insufficient', label: 'insufficient' },
                { value: 'no_data', label: 'no data' },
              ]}
              onValueChange={setState}
              triggerClassName="h-11 w-40"
            />
          </Filter>
          <label className="grid min-w-40 flex-1 gap-1 text-xs text-muted-foreground">
            product search
            <Input
              aria-label="Search products"
              placeholder="search products…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-11"
            />
          </label>
          <Button
            variant="outline"
            onClick={reload}
            className="min-h-11"
            aria-label="Refresh speed report"
          >
            <RefreshCw />
            refresh
          </Button>
        </FilterBar>
      </div>
      {loading ? <SpeedTableSkeleton /> : null}
      {error ? (
        <ErrorState
          title="could not load speed"
          description={error}
          primaryAction={{ label: 'retry speed report', onClick: reload }}
        />
      ) : null}
      {!loading && report ? (
        <>
          <p className="text-xs leading-5 text-muted-foreground">
            production samples · generated{' '}
            <time dateTime={new Date(report.generated_at).toISOString()}>
              {new Date(report.generated_at).toLocaleString()}
            </time>{' '}
            · refreshes every minute while visible.
          </p>
          {!report.products.length ||
          report.products.every((product) => product.state === 'no_data') ? (
            <EmptyState
              role="status"
              title="no speed samples yet"
              description={<EnableSpeedData />}
              className="rounded-xl border p-5"
            />
          ) : null}
          <SpeedTable
            products={products}
            report={report}
            sort={sort}
            ascending={ascending}
            onSort={(key) => {
              setAscending(key === sort ? !ascending : true);
              setSort(key);
            }}
          />
        </>
      ) : null}
    </section>
  );
}

function Filter({ label, children }: { label: string; children: React.ReactNode }): ReactElement {
  return (
    <div className="grid gap-1 text-xs text-muted-foreground">
      <span>{label}</span>
      {children}
    </div>
  );
}
