import { Fragment, useState, type ReactElement } from 'react';
import type { SpeedReportV1 } from '@app-health/contracts';
import { ArrowUpDown, ChevronDown, ChevronRight } from 'lucide-react';
import { Badge } from '@saas-maker/ui/components/badge';
import { DataTableSkeleton } from './components/ResourceTable.js';
import { EmptyState } from '@saas-maker/ui/components/empty-state';
import { Skeleton } from '@saas-maker/ui/components/skeleton';
import { Button } from '@saas-maker/ui/components/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@saas-maker/ui/components/table';
import { SpeedRoutes, SpeedValue } from './SpeedRoutes.js';
import {
  formatSpeed,
  isBreaching,
  metricBreaches,
  productMetric,
  stateLabels,
  vitalColumns,
  type SpeedProduct,
  type SpeedSort,
} from './lib/speed-display.js';

const columns: { key: SpeedSort; label: string }[] = [
  { key: 'name', label: 'Product' },
  { key: 'state', label: 'State' },
  ...vitalColumns,
  { key: 'server', label: 'Server p95' },
  { key: 'errors', label: 'Error rate' },
  { key: 'cache', label: 'Cache hit ratio' },
  { key: 'samples', label: 'Samples' },
];

function columnHeading(label: string): string {
  return label.endsWith(' p75') ? label : label.toLowerCase();
}

function ProductCells({
  product,
  expanded,
  onToggle,
}: {
  product: SpeedProduct;
  expanded: boolean;
  onToggle: () => void;
}): ReactElement {
  return (
    <>
      <TableCell className="max-w-48 !whitespace-normal">
        <Button
          variant="ghost"
          className="h-auto min-h-11 w-full justify-start px-0 text-left font-medium"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={`speed-routes-${product.app_id}`}
          aria-label={`${expanded ? 'Hide' : 'Show'} routes for ${product.name}`}
        >
          {expanded ? <ChevronDown /> : <ChevronRight />}
          <span className="break-words whitespace-normal">{product.name}</span>
        </Button>
      </TableCell>
      <TableCell>
        <div className="flex flex-col items-start gap-1">
          <Badge variant="outline" className="text-[11px]">
            {stateLabels[product.state]}
          </Badge>
          {isBreaching(product) ? (
            <Badge variant="outline" className="border-warning/30 text-warning">
              breaching
            </Badge>
          ) : null}
        </div>
      </TableCell>
      {columns.slice(2).map(({ key }) => (
        <TableCell key={key} className="tabular-nums">
          <SpeedValue
            value={productMetric(product, key as Exclude<SpeedSort, 'name' | 'state'>)}
            metric={key}
            breached={metricBreaches(product, key as Exclude<SpeedSort, 'name' | 'state'>)}
          />
        </TableCell>
      ))}
    </>
  );
}

function BudgetCaption({ report }: { report: SpeedReportV1 }): ReactElement {
  const web = report.budgets.vitals;
  const rejected = report.products.reduce((sum, product) => sum + product.rejected, 0);
  const truncated = report.products.some(
    (product) => product.vitals.truncated || product.server.truncated,
  );
  return (
    <p
      id="speed-bounds"
      className="border-t px-4 py-4 text-xs leading-6 text-muted-foreground sm:px-5"
    >
      samples, not total traffic. percentiles show the worst retained route; error rate and cache
      hit ratio use retained server routes. samples combines web and server events. truncated:{' '}
      {truncated ? 'yes — some samples or routes may be omitted' : 'no'}. rejected events:{' '}
      {rejected.toLocaleString()}. breaches require {report.min_samples.vitals} samples per web
      metric per route or {report.min_samples.server} per server route; sustained windows require{' '}
      {report.min_samples.alert_window} samples. smaller sets can show values but never percentile
      breaches. budgets ({report.class}):{' '}
      {web
        ? vitalColumns
            .map(
              ({ key, label }) =>
                `${label} ${web[key] ? formatSpeed(web[key].p75, key) : 'not set'}`,
            )
            .join(' · ')
        : 'no Web Vitals budget'}
      . server API read: p50 {formatSpeed(report.budgets.server.p50, 'p50')} · p95{' '}
      {formatSpeed(report.budgets.server.p95, 'p95')} · p99{' '}
      {formatSpeed(report.budgets.server.p99, 'p99')}. cache hit ratio is HIT / (samples − NONE).
    </p>
  );
}

export function SpeedTable({
  products,
  report,
  sort,
  ascending,
  onSort,
}: {
  products: SpeedProduct[];
  report: SpeedReportV1;
  sort: SpeedSort;
  ascending: boolean;
  onSort: (key: SpeedSort) => void;
}): ReactElement {
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <div className="min-w-0 rounded-xl border">
      <div className="border-b px-4 py-4 sm:px-5">
        <h2 className="text-sm font-semibold">product speed</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {products.length} of {report.products.length} products · select a product to inspect
          routes.
        </p>
        <p className="mt-2 text-xs text-muted-foreground lg:hidden">
          scroll the table sideways to see all timings.
        </p>
      </div>
      <Table aria-label="Product speed" aria-describedby="speed-bounds" className="text-xs">
        <TableHeader>
          <TableRow>
            {columns.map(({ key, label }) => (
              <TableHead
                key={key}
                aria-sort={sort === key ? (ascending ? 'ascending' : 'descending') : 'none'}
                className="px-2"
                style={{ minWidth: key === 'name' ? '12rem' : '6rem' }}
              >
                <Button
                  variant="ghost"
                  onClick={() => onSort(key)}
                  className="h-auto min-h-11 gap-1 px-0 text-left text-xs !whitespace-normal"
                  aria-label={`Sort by ${label}`}
                >
                  {columnHeading(label)}
                  <ArrowUpDown className="!size-3 text-muted-foreground" aria-hidden="true" />
                </Button>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {products.map((product) => (
            <Fragment key={product.app_id}>
              <TableRow>
                <ProductCells
                  product={product}
                  expanded={expanded === product.app_id}
                  onToggle={() => setExpanded(expanded === product.app_id ? null : product.app_id)}
                />
              </TableRow>
              {expanded === product.app_id ? (
                <TableRow>
                  <TableCell
                    colSpan={columns.length}
                    className="bg-muted/20 p-0 !whitespace-normal"
                  >
                    <div id={`speed-routes-${product.app_id}`} className="w-0 min-w-full">
                      <SpeedRoutes product={product} />
                    </div>
                  </TableCell>
                </TableRow>
              ) : null}
            </Fragment>
          ))}
        </TableBody>
      </Table>
      {!products.length ? (
        <EmptyState
          role="status"
          title="no products match these filters."
          description="try another state or search."
        />
      ) : null}
      <BudgetCaption report={report} />
    </div>
  );
}

export function SpeedTableSkeleton(): ReactElement {
  return (
    <div role="status" aria-label="Loading speed report" className="min-w-0 rounded-xl border">
      <div className="space-y-2 border-b px-4 py-4 sm:px-5">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <DataTableSkeleton
        announce={false}
        columns={columns.map(({ key, label }) => ({
          id: key,
          header: columnHeading(label),
          minWidth: key === 'name' ? '12rem' : '6rem',
          className: 'h-16',
        }))}
        rows={4}
        className="[&>div:first-child]:hidden"
      />
    </div>
  );
}
