import type { ReactNode, ReactElement } from 'react';
import { Badge } from './components/ui/badge.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './components/ui/table.js';
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
  const labels = { breach: 'Breaching', ok: 'Within budget', insufficient: 'Insufficient windows' };
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
    <span className="text-muted-foreground">None reported</span>
  );
}

function RouteTable({
  label,
  headings,
  children,
}: {
  label: string;
  headings: string[];
  children: ReactNode;
}): ReactElement {
  return (
    <Table aria-label={label} className="text-xs">
      <TableHeader>
        <TableRow>
          {headings.map((heading) => (
            <TableHead key={heading}>{heading}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>{children}</TableBody>
    </Table>
  );
}

function VitalsRoutes({ product }: { product: SpeedProduct }): ReactElement {
  if (!product.vitals.routes.length)
    return <p className="text-sm text-muted-foreground">No Web Vitals route samples.</p>;
  return (
    <RouteTable
      label={`${product.name} vitals routes`}
      headings={[
        'Route group',
        'Samples',
        ...vitalColumns.map((column) => column.label),
        'Breaches',
        'Sustained LCP',
      ]}
    >
      {product.vitals.routes.map((route) => (
        <TableRow key={route.route_group}>
          <TableCell className="font-mono">{route.route_group}</TableCell>
          <TableCell>
            <SpeedValue value={route.samples || null} metric="samples" />
          </TableCell>
          {vitalColumns.map(({ key }) => (
            <TableCell key={key}>
              <SpeedValue
                value={route[key]?.p75 ?? null}
                metric={key}
                breached={route.breaches.some((breach) => breach.metric === key)}
              />
            </TableCell>
          ))}
          <TableCell>
            <Breaches route={route} />
          </TableCell>
          <TableCell>
            <Sustained state={route.sustained} />
          </TableCell>
        </TableRow>
      ))}
    </RouteTable>
  );
}

function ServerRoutes({ product }: { product: SpeedProduct }): ReactElement {
  if (!product.server.routes.length)
    return <p className="text-sm text-muted-foreground">No server route samples.</p>;
  return (
    <RouteTable
      label={`${product.name} server routes`}
      headings={[
        'Route template',
        'Samples',
        'p50',
        'p95',
        'p99',
        'Error rate',
        'Edge cache',
        'Top colos · p95',
        'Stages · p95',
        'Breaches',
        'Sustained p95',
      ]}
    >
      {product.server.routes.map((route) => (
        <TableRow key={route.route}>
          <TableCell className="max-w-64 !whitespace-normal break-all font-mono">
            {route.route}
          </TableCell>
          <TableCell>
            <SpeedValue value={route.samples || null} metric="samples" />
          </TableCell>
          {(['p50', 'p95', 'p99'] as const).map((percentile) => (
            <TableCell key={percentile}>
              <SpeedValue
                value={route.total_ms[percentile]}
                metric={percentile}
                breached={route.breaches.some(
                  (breach) => breach.metric === `total_ms.${percentile}`,
                )}
              />
            </TableCell>
          ))}
          <TableCell>
            <SpeedValue value={route.samples ? route.error_rate : null} metric="errors" />
          </TableCell>
          <TableCell>
            <div>
              Hit ratio: <SpeedValue value={route.cache.hit_ratio} metric="cache" />
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
          </TableCell>
          <TableCell>
            <DetailList
              entries={route.colos.map(
                (colo) =>
                  `${colo.colo}: ${formatSpeed(colo.p95_ms, 'p95')} · ${colo.samples} samples`,
              )}
            />
          </TableCell>
          <TableCell>
            <DetailList
              entries={Object.entries(route.stages_p95_ms).map(
                ([stage, value]) => `${stage}: ${formatSpeed(value, 'p95')}`,
              )}
            />
          </TableCell>
          <TableCell>
            <Breaches route={route} />
          </TableCell>
          <TableCell>
            <Sustained state={route.sustained} />
          </TableCell>
        </TableRow>
      ))}
    </RouteTable>
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
        {product.vitals.truncated ? <Badge variant="secondary">Vitals truncated</Badge> : null}
        {product.server.truncated ? <Badge variant="secondary">Server truncated</Badge> : null}
      </div>
      <section className="min-w-0 space-y-2" aria-label="Field Web Vitals">
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Field Web Vitals
        </h4>
        <VitalsRoutes product={product} />
      </section>
      <section className="min-w-0 space-y-2" aria-label="Server timings">
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Server timings
        </h4>
        <ServerRoutes product={product} />
      </section>
      <p className="text-xs leading-5 text-muted-foreground">
        Sustained evaluates LCP p75 and server p95 over four consecutive 15-minute windows, ending
        at report generation.
      </p>
    </div>
  );
}
