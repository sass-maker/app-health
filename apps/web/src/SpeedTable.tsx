import { Fragment, useState } from 'react';
import type { SpeedReportV1 } from '@app-health/contracts';
import { ArrowUpDown, ChevronDown, ChevronRight } from 'lucide-react';
import { Badge } from './components/ui/badge.js';
import { Button } from './components/ui/button.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './components/ui/table.js';
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

function ProductCells({
  product,
  expanded,
  onToggle,
}: {
  product: SpeedProduct;
  expanded: boolean;
  onToggle: () => void;
}): JSX.Element {
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
              Breaching
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

function BudgetCaption({ report }: { report: SpeedReportV1 }): JSX.Element {
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
      Samples, not total traffic. Percentiles show the worst retained route; error rate and cache
      hit ratio use retained server routes. Samples combines web and server events. Truncated:{' '}
      {truncated ? 'yes — some samples or routes may be omitted' : 'no'}. Rejected events:{' '}
      {rejected.toLocaleString()}. Breaches require {report.min_samples.vitals} samples per web
      metric per route or {report.min_samples.server} per server route; sustained windows require{' '}
      {report.min_samples.alert_window} samples. Smaller sets can show values but never percentile
      breaches. Budgets ({report.class}):{' '}
      {web
        ? vitalColumns
            .map(
              ({ key, label }) =>
                `${label} ${web[key] ? formatSpeed(web[key].p75, key) : 'not set'}`,
            )
            .join(' · ')
        : 'no Web Vitals budget'}
      . Server API read: p50 {formatSpeed(report.budgets.server.p50, 'p50')} · p95{' '}
      {formatSpeed(report.budgets.server.p95, 'p95')} · p99{' '}
      {formatSpeed(report.budgets.server.p99, 'p99')}. Cache hit ratio is HIT / (samples − NONE).
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
}): JSX.Element {
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <div className="min-w-0 rounded-xl border">
      <div className="border-b px-4 py-4 sm:px-5">
        <h2 className="text-sm font-semibold">Product speed</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {products.length} of {report.products.length} products · Select a product to inspect
          routes.
        </p>
        <p className="mt-2 text-xs text-muted-foreground lg:hidden">
          Scroll the table sideways to see all timings.
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
              >
                <Button
                  variant="ghost"
                  onClick={() => onSort(key)}
                  className="h-auto min-h-11 gap-1 px-0 text-left text-xs !whitespace-normal"
                  aria-label={`Sort by ${label}`}
                >
                  {label}
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
        <p role="status" className="p-6 text-sm text-muted-foreground">
          No products match these filters. Try another state or search.
        </p>
      ) : null}
      <BudgetCaption report={report} />
    </div>
  );
}
