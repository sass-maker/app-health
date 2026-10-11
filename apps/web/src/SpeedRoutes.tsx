import type { ReactElement } from 'react';
import { DataTable, type DataColumn } from './components/ResourceTable.js';
import { EmptyState } from '@saas-maker/ui/components/empty-state';
import { Badge } from '@saas-maker/ui/components/badge';
import {
  formatSpeed,
  vitalColumns,
  type SpeedProduct,
  type VitalRoute,
  type ServerRoute,
} from './lib/speed-display.js';

export function SpeedValue({
  value,
  metric,
  breached = false,
}: {
  value: number | null;
  metric: string;
  breached?: boolean;
}): ReactElement {
  if (value === null)
    return (
      <span aria-label="No samples" className="text-muted-foreground">
        —
      </span>
    );
  return (
    <span className={breached ? 'text-warning' : undefined}>{formatSpeed(value, metric)}</span>
  );
}

function Sustained({ state }: { state: VitalRoute['sustained'] }): ReactElement {
  const labels = { breach: 'breaching', ok: 'within budget', insufficient: 'insufficient windows' };
  return (
    <span className={state === 'breach' ? 'text-warning' : 'text-muted-foreground'}>
      {labels[state]}
    </span>
  );
}

function Breaches({ route }: { route: VitalRoute | ServerRoute }): ReactElement {
  return route.breaches.length ? (
    <ul className="space-y-1 text-xs text-warning">
      {route.breaches.map((breach) => (
        <li key={breach.metric}>
          {breach.metric}: {formatSpeed(breach.value, breach.metric)} &gt;{' '}
          {formatSpeed(breach.budget, breach.metric)}
        </li>
      ))}
    </ul>
  ) : (
    <span className="text-muted-foreground">none reported</span>
  );
}

function routeColumn<T>(
  id: string,
  header: string,
  value: DataColumn<T>['value'],
  cell: DataColumn<T>['cell'],
  className?: string,
): DataColumn<T> {
  return { id, header, value, cell, className, sortable: false, hideable: false };
}

function VitalsRoutes({ product }: { product: SpeedProduct }): ReactElement {
  const columns: DataColumn<VitalRoute>[] = [
    routeColumn('route_group', 'route group', (route) => route.route_group, undefined, 'font-mono'),
    routeColumn(
      'samples',
      'samples',
      (route) => route.samples,
      (route) => <SpeedValue value={route.samples || null} metric="samples" />,
    ),
    ...vitalColumns.map(({ key, label }) =>
      routeColumn<VitalRoute>(
        key,
        label,
        (route) => route[key]?.p75,
        (route) => (
          <SpeedValue
            value={route[key]?.p75 ?? null}
            metric={key}
            breached={route.breaches.some((breach) => breach.metric === key)}
          />
        ),
      ),
    ),
    routeColumn(
      'breaches',
      'breaches',
      () => null,
      (route) => <Breaches route={route} />,
    ),
    routeColumn(
      'sustained',
      'sustained LCP',
      (route) => route.sustained,
      (route) => <Sustained state={route.sustained} />,
    ),
  ];
  return (
    <DataTable
      label={`${product.name} vitals routes`}
      data={product.vitals.routes}
      columns={columns}
      getRowId={(route) => route.route_group}
      pageSize={Math.max(1, product.vitals.routes.length)}
      maxHeight="none"
      empty={<EmptyState title="no Web Vitals route samples." />}
    />
  );
}

function EdgeCache({ route }: { route: ServerRoute }): ReactElement {
  return (
    <div>
      <div>
        hit ratio: <SpeedValue value={route.cache.hit_ratio} metric="cache" />
      </div>
      <ul className="mt-1 space-y-1 text-muted-foreground">
        {Object.entries(route.cache)
          .filter(([key]) => key !== 'hit_ratio')
          .map(([key, value]) => (
            <li key={key}>
              {key}: {value}
            </li>
          ))}
      </ul>
    </div>
  );
}

const serverRouteColumns: DataColumn<ServerRoute>[] = [
  routeColumn(
    'route',
    'route template',
    (route) => route.route,
    undefined,
    'max-w-64 !whitespace-normal break-all font-mono',
  ),
  routeColumn(
    'samples',
    'samples',
    (route) => route.samples,
    (route) => <SpeedValue value={route.samples || null} metric="samples" />,
  ),
  ...(['p50', 'p95', 'p99'] as const).map((percentile) =>
    routeColumn<ServerRoute>(
      percentile,
      percentile,
      (route) => route.total_ms[percentile],
      (route) => (
        <SpeedValue
          value={route.total_ms[percentile]}
          metric={percentile}
          breached={route.breaches.some((breach) => breach.metric === `total_ms.${percentile}`)}
        />
      ),
    ),
  ),
  routeColumn(
    'errors',
    'error rate',
    (route) => route.error_rate,
    (route) => <SpeedValue value={route.samples ? route.error_rate : null} metric="errors" />,
  ),
  routeColumn(
    'cache',
    'edge cache',
    (route) => route.cache.hit_ratio,
    (route) => <EdgeCache route={route} />,
  ),
  routeColumn(
    'colos',
    'top colos · p95',
    () => null,
    (route) => (
      <DetailList
        entries={route.colos.map(
          (colo) => `${colo.colo}: ${formatSpeed(colo.p95_ms, 'p95')} · ${colo.samples} samples`,
        )}
      />
    ),
  ),
  routeColumn(
    'stages',
    'stages · p95',
    () => null,
    (route) => (
      <DetailList
        entries={Object.entries(route.stages_p95_ms).map(
          ([stage, value]) => `${stage}: ${formatSpeed(value, 'p95')}`,
        )}
      />
    ),
  ),
  routeColumn(
    'breaches',
    'breaches',
    () => null,
    (route) => <Breaches route={route} />,
  ),
  routeColumn(
    'sustained',
    'sustained p95',
    (route) => route.sustained,
    (route) => <Sustained state={route.sustained} />,
  ),
];

function ServerRoutes({ product }: { product: SpeedProduct }): ReactElement {
  return (
    <DataTable
      label={`${product.name} server routes`}
      data={product.server.routes}
      columns={serverRouteColumns}
      getRowId={(route) => route.route}
      pageSize={Math.max(1, product.server.routes.length)}
      maxHeight="none"
      empty={<EmptyState title="no server route samples." />}
    />
  );
}

function DetailList({ entries }: { entries: string[] }): ReactElement {
  return entries.length ? (
    <ul className="space-y-1">
      {entries.map((entry) => (
        <li key={entry}>{entry}</li>
      ))}
    </ul>
  ) : (
    <SpeedValue value={null} metric="samples" />
  );
}

export function SpeedRoutes({ product }: { product: SpeedProduct }): ReactElement {
  return (
    <div className="min-w-0 space-y-6 p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{product.name} routes</h3>
        <Badge variant="outline">{product.rejected} rejected</Badge>
        {product.vitals.truncated ? <Badge variant="secondary">vitals truncated</Badge> : null}
        {product.server.truncated ? <Badge variant="secondary">server truncated</Badge> : null}
      </div>
      <section className="min-w-0 space-y-2" aria-label="Field Web Vitals">
        <h4 className="text-xs font-medium tracking-wide text-muted-foreground">
          field Web Vitals
        </h4>
        <VitalsRoutes product={product} />
      </section>
      <section className="min-w-0 space-y-2" aria-label="Server timings">
        <h4 className="text-xs font-medium tracking-wide text-muted-foreground">server timings</h4>
        <ServerRoutes product={product} />
      </section>
      <p className="text-xs leading-5 text-muted-foreground">
        sustained evaluates LCP p75 and server p95 over four consecutive 15-minute windows, ending
        at report generation.
      </p>
    </div>
  );
}
