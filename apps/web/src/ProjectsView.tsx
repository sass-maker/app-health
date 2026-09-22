import { useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  CircleDashed,
  RefreshCw,
  Search,
  ShieldAlert,
} from 'lucide-react';
import { CartesianGrid, ReferenceLine, Scatter, ScatterChart, XAxis, YAxis, ZAxis } from 'recharts';
import type {
  BrowserSummary,
  WorkspaceHealthEnvironmentV1,
  WorkspaceEndpointStateV1,
} from '@app-health/contracts';
import { Badge } from './components/ui/badge.js';
import { Button } from './components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card.js';
import { ChartContainer } from './components/ui/chart.js';
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
import { useWorkspaceAnalytics, useWorkspaceHealth } from './useAnalytics.js';

interface ProjectsViewProject {
  appId: string;
  environmentId: string;
  name: string;
  environment: string;
}

interface ProjectsViewProps {
  projects: ProjectsViewProject[];
  ownerToken: string;
  onOpen: (project: ProjectsViewProject) => void;
}

type AnalyticsProject = BrowserSummary['projects'][number];
type HealthEnvironment = WorkspaceHealthEnvironmentV1;

interface WatchtowerRow {
  project: ProjectsViewProject;
  analytics?: AnalyticsProject;
  health?: HealthEnvironment;
}

const number = (value: number) => value.toLocaleString();
const percent = (value: number) => `${(value * 100).toFixed(value < 0.01 ? 1 : 0)}%`;

const stateLabels: Record<WorkspaceEndpointStateV1, string> = {
  connected: 'Connected',
  stale: 'Stale',
  waiting: 'Waiting',
  revoked: 'Key revoked',
  unconfigured: 'Not configured',
};

function age(timestamp: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function Freshness({ timestamp, now }: { timestamp: number | null | undefined; now: number }) {
  if (timestamp == null) return <span className="text-muted-foreground">Never received</span>;
  const date = new Date(timestamp);
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString()}>
      {age(timestamp, now)}
    </time>
  );
}

function severity(row: WatchtowerRow): number {
  const health = row.health;
  if (!health) return 6;
  if (health.endpoints.metrics?.health_state === 'unhealthy') return 0;
  if (health.endpoints.state === 'revoked') return 1;
  if (health.endpoints.state === 'stale') return 2;
  if (health.endpoints.metrics?.health_state === 'degraded') return 3;
  if (health.endpoints.state === 'waiting') return 4;
  if (health.endpoints.state === 'unconfigured') return 5;
  return 7;
}

function attentionLabel(row: WatchtowerRow): string {
  const endpoints = row.health?.endpoints;
  if (!endpoints) return 'Health has not loaded';
  if (endpoints.metrics?.health_state === 'unhealthy') return 'Unhealthy requests';
  if (endpoints.state === 'revoked') return 'Ingest key revoked';
  if (endpoints.state === 'stale') return 'Endpoint data is stale';
  if (endpoints.metrics?.health_state === 'degraded') return 'Request health degraded';
  if (endpoints.state === 'waiting') return 'Waiting for endpoint data';
  if (endpoints.state === 'unconfigured') return 'Endpoint monitoring not configured';
  return 'Healthy';
}

function isAttention(row: WatchtowerRow): boolean {
  return severity(row) < 7;
}

function statusBadge(row: WatchtowerRow) {
  const endpoints = row.health?.endpoints;
  if (!endpoints) return <Badge variant="outline">Unknown</Badge>;
  const requestHealth = endpoints.metrics?.health_state;
  if (requestHealth === 'unhealthy') return <Badge variant="destructive">Unhealthy</Badge>;
  if (requestHealth === 'degraded')
    return <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-300">Degraded</Badge>;
  if (endpoints.state !== 'connected')
    return <Badge variant="outline">{stateLabels[endpoints.state]}</Badge>;
  if (requestHealth === 'healthy')
    return (
      <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">Healthy</Badge>
    );
  return <Badge variant="secondary">Low volume</Badge>;
}

function WatchtowerTotals({ rows, healthReady }: { rows: WatchtowerRow[]; healthReady: boolean }) {
  const metrics = rows.flatMap((row) =>
    row.health?.endpoints.metrics ? [row.health.endpoints.metrics] : [],
  );
  const requests = metrics.reduce((sum, item) => sum + item.request_count, 0);
  const errors = metrics.reduce((sum, item) => sum + item.error_count, 0);
  const cells = [
    {
      label: 'Projects watched',
      value: new Set(rows.map((row) => row.project.appId)).size,
      note: `${rows.length} environments in inventory`,
      color: 'var(--chart-3)',
    },
    {
      label: 'Requests',
      value: metrics.length ? requests : null,
      note: 'Measured · last 24 hours',
      color: 'var(--chart-1)',
    },
    {
      label: 'Request error rate',
      value: requests ? percent(errors / requests) : metrics.length ? '0%' : null,
      note: '5xx responses · last 24 hours',
      color: 'var(--chart-4)',
    },
    {
      label: 'Need attention',
      value: healthReady ? rows.filter(isAttention).length : null,
      note: 'Health, freshness, or setup issue',
      color: 'var(--chart-2)',
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-label="Watchtower totals">
      {cells.map((cell) => (
        <Card
          key={cell.label}
          className="border-t-2 py-0 shadow-none"
          style={{ borderTopColor: cell.color }}
        >
          <CardContent className="p-5">
            <p className="text-xs font-medium text-muted-foreground">{cell.label}</p>
            <p className="mt-3 text-3xl font-semibold tabular-nums tracking-tight">
              {cell.value == null
                ? '—'
                : typeof cell.value === 'number'
                  ? number(cell.value)
                  : cell.value}
            </p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{cell.note}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function AttentionQueue({
  rows,
  onOpen,
}: {
  rows: WatchtowerRow[];
  onOpen: ProjectsViewProps['onOpen'];
}) {
  const attention = rows
    .filter(isAttention)
    .sort((left, right) => severity(left) - severity(right));
  return (
    <Card className="self-start gap-0 py-0 shadow-none">
      <CardHeader className="border-b px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm">
              <ShieldAlert className="size-4 text-amber-500" /> Attention queue
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">Highest-risk environments first</p>
          </div>
          <Badge variant={attention.length ? 'outline' : 'secondary'}>{attention.length}</Badge>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {attention.length ? (
          <ol className="divide-y">
            {attention.slice(0, 6).map((row) => (
              <li key={`${row.project.appId}:${row.project.environmentId}`}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 px-5 py-3.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => onOpen(row.project)}
                >
                  <AlertTriangle className="size-4 shrink-0 text-amber-500" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{row.project.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {row.project.environment} · {attentionLabel(row)}
                    </span>
                  </span>
                  {statusBadge(row)}
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <div className="flex items-center gap-3 p-6 text-sm text-muted-foreground">
            <CheckCircle2 className="size-5 text-emerald-500" /> No known exceptions in the current
            inventory.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ReliabilityField({ rows }: { rows: WatchtowerRow[] }) {
  const points = rows.flatMap((row) => {
    const metrics = row.health?.endpoints.metrics;
    if (!metrics) return [];
    return [
      {
        name: `${row.project.name} · ${row.project.environment}`,
        latency: metrics.p95_ms,
        errors: metrics.error_rate * 100,
        requests: metrics.request_count,
        fill:
          metrics.health_state === 'unhealthy'
            ? 'var(--destructive)'
            : metrics.health_state === 'degraded'
              ? 'var(--chart-4)'
              : 'var(--chart-2)',
      },
    ];
  });
  return (
    <Card className="gap-0 py-0 shadow-none">
      <CardHeader className="border-b px-5 py-4">
        <CardTitle className="text-sm">Reliability field</CardTitle>
        <p className="text-xs text-muted-foreground">
          p95 latency against 5xx rate · bubble size is request volume
        </p>
      </CardHeader>
      <CardContent className="p-4">
        {points.length ? (
          <>
            <ChartContainer
              config={{ requests: { label: 'Requests', color: 'var(--chart-1)' } }}
              className="min-h-64 w-full"
            >
              <ScatterChart margin={{ top: 12, right: 18, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" dataKey="latency" name="p95 latency" unit="ms" />
                <YAxis type="number" dataKey="errors" name="5xx rate" unit="%" width={42} />
                <ZAxis type="number" dataKey="requests" range={[50, 360]} />
                <ReferenceLine x={1000} stroke="var(--chart-4)" strokeDasharray="4 4" />
                <ReferenceLine y={1} stroke="var(--chart-4)" strokeDasharray="4 4" />
                <Scatter data={points} shape="circle" />
              </ScatterChart>
            </ChartContainer>
            <ul className="sr-only" aria-label="Reliability field values">
              {points.map((point) => (
                <li key={point.name}>
                  {point.name}: {point.requests} requests, {point.errors.toFixed(1)}% errors,{' '}
                  {point.latency}ms p95
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div className="flex min-h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
            <CircleDashed className="size-4" /> No measured requests in this window
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function InventoryTable({
  rows,
  now,
  onOpen,
}: {
  rows: WatchtowerRow[];
  now: number;
  onOpen: ProjectsViewProps['onOpen'];
}) {
  return (
    <CardContent className="p-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-5">Project</TableHead>
            <TableHead>Browser usage · 24h</TableHead>
            <TableHead>Request health · 24h</TableHead>
            <TableHead>Endpoint freshness</TableHead>
            <TableHead className="pr-5 text-right">
              <span className="sr-only">Open</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const metrics = row.health?.endpoints.metrics;
            return (
              <TableRow key={`${row.project.appId}:${row.project.environmentId}`}>
                <TableCell className="pl-5">
                  <p className="font-medium">{row.project.name}</p>
                  <p className="text-xs text-muted-foreground">{row.project.environment}</p>
                </TableCell>
                <TableCell>
                  {row.analytics ? (
                    <>
                      <span className="font-medium tabular-nums">
                        {number(row.analytics.pageviews)}
                      </span>
                      <span className="ml-1 text-xs text-muted-foreground">views</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    {statusBadge(row)}
                    {metrics ? (
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {number(metrics.request_count)} requests
                      </span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="text-xs">
                  <Freshness timestamp={row.health?.endpoints.last_received_at} now={now} />
                </TableCell>
                <TableCell className="pr-5 text-right">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => onOpen(row.project)}
                  >
                    Open <ArrowUpRight className="size-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {!rows.length ? (
        <p className="p-8 text-center text-sm text-muted-foreground">
          No environments match this view.
        </p>
      ) : null}
    </CardContent>
  );
}

function Inventory({
  rows,
  now,
  onOpen,
}: {
  rows: WatchtowerRow[];
  now: number;
  onOpen: ProjectsViewProps['onOpen'];
}) {
  const [query, setQuery] = useState('');
  const [attentionOnly, setAttentionOnly] = useState(false);
  const filtered = rows.filter((row) => {
    const matches = `${row.project.name} ${row.project.environment}`
      .toLowerCase()
      .includes(query.trim().toLowerCase());
    return matches && (!attentionOnly || isAttention(row));
  });
  return (
    <Card className="gap-0 py-0 shadow-none">
      <CardHeader className="gap-4 border-b px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <CardTitle className="text-sm">Complete inventory</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Every environment stays visible, including quiet ones
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <label className="relative min-w-60">
            <Search
              className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground"
              aria-hidden="true"
            />
            <span className="sr-only">Search inventory</span>
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search projects"
              className="pl-9"
            />
          </label>
          <Button
            type="button"
            variant={attentionOnly ? 'secondary' : 'outline'}
            onClick={() => setAttentionOnly((value) => !value)}
            aria-pressed={attentionOnly}
          >
            Attention only
          </Button>
        </div>
      </CardHeader>
      <InventoryTable rows={filtered} now={now} onOpen={onOpen} />
    </Card>
  );
}

function EmptyProjectsView() {
  return (
    <section aria-labelledby="projects-title" className="mx-auto w-full max-w-6xl">
      <Card className="shadow-none">
        <CardContent className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
          <h2 id="projects-title" className="text-lg font-semibold tracking-tight">
            No projects yet
          </h2>
          <p className="max-w-md text-sm text-muted-foreground">
            Add an environment to start watching usage and request health.
          </p>
        </CardContent>
      </Card>
    </section>
  );
}

function WatchtowerHeader({
  refreshedAt,
  error,
  reload,
}: {
  refreshedAt?: number;
  error: string;
  reload: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Portfolio watchtower
        </p>
        <h2 id="projects-title" className="mt-1 text-2xl font-semibold tracking-tight">
          What needs attention now?
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Usage and request reliability across every configured environment.
        </p>
      </div>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        {refreshedAt ? (
          <span>
            Refreshed <Freshness timestamp={refreshedAt} now={Date.now()} />
          </span>
        ) : null}
        {error ? (
          <Button type="button" variant="outline" size="sm" onClick={reload}>
            <RefreshCw /> Retry
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function ProjectsView({ projects, ownerToken, onOpen }: ProjectsViewProps): JSX.Element {
  const analytics = useWorkspaceAnalytics(ownerToken);
  const health = useWorkspaceHealth(ownerToken);
  const rows = useMemo(
    () =>
      projects.map((project): WatchtowerRow => ({
        project,
        analytics: analytics.data?.projects.find(
          (item) => item.app_id === project.appId && item.environment_id === project.environmentId,
        ),
        health: health.data?.environments.find(
          (item) => item.app_id === project.appId && item.environment_id === project.environmentId,
        ),
      })),
    [projects, analytics.data, health.data],
  );
  const now = health.data?.refreshed_at ?? analytics.data?.live.measured_at ?? Date.now();

  if (!projects.length) return <EmptyProjectsView />;

  const error = health.error || analytics.error;
  const loading = !health.data && !health.error;
  return (
    <section aria-labelledby="projects-title" className="mx-auto w-full max-w-7xl space-y-6">
      <WatchtowerHeader
        refreshedAt={health.data?.refreshed_at}
        error={error}
        reload={() => {
          health.reload();
          analytics.reload();
        }}
      />
      <WatchtowerTotals rows={rows} healthReady={Boolean(health.data || health.error)} />
      {error ? (
        <Card role="alert" className="border-destructive/40 bg-destructive/5 shadow-none">
          <CardContent className="flex items-start gap-3 p-4 text-sm">
            <AlertTriangle className="mt-0.5 size-4 text-destructive" />
            <div>
              <p className="font-medium">Some Watchtower data could not refresh</p>
              <p className="mt-1 text-xs text-muted-foreground">{error}</p>
            </div>
          </CardContent>
        </Card>
      ) : null}
      {loading ? (
        <div
          role="status"
          aria-label="Loading Watchtower"
          className="grid gap-4 lg:grid-cols-[0.8fr_1.2fr]"
        >
          <Skeleton className="h-80 w-full rounded-xl" />
          <Skeleton className="h-80 w-full rounded-xl" />
          <span className="sr-only">Loading Watchtower…</span>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
          <AttentionQueue rows={rows} onOpen={onOpen} />
          <ReliabilityField rows={rows} />
        </div>
      )}
      <Inventory rows={rows} now={now} onOpen={onOpen} />
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Activity className="size-3" /> Requests are server or function calls, never a count of
        people. Missing data is shown as unknown.
      </p>
    </section>
  );
}
