import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { SpeedReportV1, type SpeedReportV1 as Report } from '@app-health/contracts';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from './components/ui/alert.js';
import { Button } from './components/ui/button.js';
import { Input } from './components/ui/input.js';
import { Skeleton } from './components/ui/skeleton.js';
import { LabeledSelect } from './LabeledSelect.js';
import { SpeedTable } from './SpeedTable.js';
import { ownerFetch } from './lib/owner-fetch.js';
import { pollWhileVisible } from './lib/visible-poll.js';
import { isBreaching, sortSpeedProducts, type SpeedSort } from './lib/speed-display.js';

const reportErrors: Record<number, string> = {
  400: 'Invalid speed filters (400). Choose a supported range and class, then retry.',
  403: 'Workspace owner access required (403). Sign in with the workspace owner session.',
  503: 'Speed reporting is unavailable (503). The report service is not ready; try again shortly.',
};

function useSpeedReport(
  ownerToken: string,
  range: Report['range'],
  performanceClass: Report['class'],
) {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let pending = false;
    let controller: AbortController | undefined;
    setReport(null);
    setError('');
    setLoading(true);
    async function load(): Promise<void> {
      if (pending || document.visibilityState === 'hidden') return;
      pending = true;
      controller = new AbortController();
      try {
        const response = await ownerFetch(
          `/v1/reports/speed?range=${range}&class=${performanceClass}`,
          ownerToken,
          { signal: controller.signal },
        );
        if (!response.ok)
          throw new Error(
            reportErrors[response.status] ??
              `Speed report returned ${response.status}. Please retry.`,
          );
        const parsed = SpeedReportV1.safeParse(await response.json());
        if (
          !parsed.success ||
          parsed.data.range !== range ||
          parsed.data.class !== performanceClass
        )
          throw new Error('Invalid speed report response. Please retry.');
        if (!cancelled) {
          setReport(parsed.data);
          setError('');
        }
      } catch (cause) {
        if (!cancelled)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Could not load the speed report. Please retry.',
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
  }, [ownerToken, range, performanceClass, retry]);
  return { report, error, loading, reload: () => setRetry((value) => value + 1) };
}

function EnableSpeedData(): ReactElement {
  return (
    <p className="text-sm leading-6 text-muted-foreground">
      Enable tracker <code>data-vitals</code> and server <code>api.stage_timing</code> logs to
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
      <div className="flex flex-wrap items-end gap-3 border-b pb-5" aria-label="Speed filters">
        <Filter label="Range">
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
        <Filter label="Class">
          <LabeledSelect
            label="Performance class"
            value={performanceClass}
            options={[
              { value: 'landing', label: 'Landing' },
              { value: 'app', label: 'App' },
              { value: 'api', label: 'API' },
            ]}
            onValueChange={(value) => setClass(value as Report['class'])}
            triggerClassName="h-11 w-32"
          />
        </Filter>
        <Filter label="State">
          <LabeledSelect
            label="Speed state"
            value={state}
            options={[
              { value: 'all', label: 'All' },
              { value: 'breaching', label: 'Breaching' },
              { value: 'insufficient', label: 'Insufficient' },
              { value: 'no_data', label: 'No data' },
            ]}
            onValueChange={setState}
            triggerClassName="h-11 w-40"
          />
        </Filter>
        <label className="grid min-w-40 flex-1 gap-1 text-xs text-muted-foreground">
          Product search
          <Input
            aria-label="Search products"
            placeholder="Search products…"
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
          Refresh
        </Button>
      </div>
      {loading ? (
        <div role="status" aria-label="Loading speed report" className="space-y-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Could not load speed</AlertTitle>
          <AlertDescription>
            {error}
            <Button variant="outline" onClick={reload} className="mt-3 min-h-11 self-start">
              Retry speed report
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {!loading && !error && report ? (
        <>
          <p className="text-xs leading-5 text-muted-foreground">
            Production samples · Generated{' '}
            <time dateTime={new Date(report.generated_at).toISOString()}>
              {new Date(report.generated_at).toLocaleString()}
            </time>{' '}
            · Refreshes every minute while visible.
          </p>
          {!report.products.length ||
          report.products.every((product) => product.state === 'no_data') ? (
            <div role="status" className="space-y-2 rounded-xl border p-5">
              <h2 className="text-sm font-semibold">No speed samples yet</h2>
              <EnableSpeedData />
            </div>
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
