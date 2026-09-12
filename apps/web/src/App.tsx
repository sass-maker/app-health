import { AnalyticsSharing } from './AnalyticsSharing.js';
import { NativeKeys } from './NativeKeys.js';
import { pollWhileVisible } from './lib/visible-poll.js';
import { EnvironmentCreateForm } from './EnvironmentCreateForm.js';
import { ProductBrand, ProductShell } from './ProductShell.js';
import { AnalyticsView } from './AnalyticsView.js';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Clock3,
  Database,
  EyeOff,
  Globe2,
  KeyRound,
  MousePointer2,
  Radio,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  DEGRADED_ERROR_RATE,
  DEGRADED_P95_MS,
  INSUFFICIENT_DATA_MIN_REQUESTS,
  LOG_LEVELS,
  LOG_SOURCES,
  LogQueryResponseV1 as LogQueryResponseV1Schema,
  SEED_APP_ID,
  SEED_APP_NAME,
  SEED_ENV_ID,
  SEED_ENV_NAME,
  UNHEALTHY_ERROR_RATE,
  UNHEALTHY_P95_MS,
  WINDOWS,
  CAPABILITY_IDS,
  EnvironmentCapabilities as EnvironmentCapabilitiesSchema,
  EnvironmentKeyResponse as EnvironmentKeyResponseSchema,
  EndpointQueryResponseV1 as EndpointQueryResponseV1Schema,
  InstallationStatusV1 as InstallationStatusV1Schema,
  type CapabilityId,
  type EnvironmentCapabilities,
  type EnvironmentKeyResponse,
  type CreateAppResponseV1,
  type EndpointAggregateV1,
  type EndpointQueryResponseV1,
  type FailureEventV1,
  type FailureQueryResponseV1,
  type InstallationStatusV1,
  type ListAppsResponseV1,
  type CreatePublicLogKeyResponseV1,
  type ListPublicLogKeysResponseV1,
  type LogLevel,
  type LogQueryResponseV1,
  type LogSource,
  type PublicLogKeyV1,
  type StoredLogV1,
  type Runtime,
  type Window,
} from '@app-health/contracts';
import { GoogleSignIn } from './GoogleSignIn.js';
import { GitHubIcon } from './GitHubIcon';
import { Badge } from './components/ui/badge.js';
import { Button } from './components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card.js';
import { Input } from './components/ui/input.js';
import { Skeleton } from './components/ui/skeleton.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './components/ui/select.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs.js';
import { Alert, AlertDescription, AlertTitle } from './components/ui/alert.js';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from './components/ui/alert-dialog.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './components/ui/table.js';
import { ThemeToggle } from './ThemeToggle.js';
import { ProjectsView } from './ProjectsView.js';

const API_BASE = (import.meta.env.VITE_APP_HEALTH_API as string | undefined) ?? '';
const INGEST_ORIGIN =
  (import.meta.env.VITE_APP_HEALTH_INGEST_ORIGIN as string | undefined) ?? window.location.origin;
const STORAGE_KEY = 'app-health-v0-project';

type SortKey = 'health' | 'requests' | 'error_rate' | 'p95' | 'last_seen';
type SortDirection = 'asc' | 'desc';
type DashboardView =
  'endpoints' | 'data' | 'logs' | 'analytics' | 'events' | 'install' | 'projects' | 'settings';

const WINDOW_LABELS: Record<Window, string> = {
  '15m': '15 minutes',
  '1h': '1 hour',
  '24h': '24 hours',
};

interface SavedProject {
  appId: string;
  environmentId: string;
  name: string;
  environment: string;
}

const healthWeight: Record<EndpointAggregateV1['health_state'], number> = {
  unhealthy: 4,
  degraded: 3,
  'insufficient-data': 2,
  healthy: 1,
};

function apiUrl(path: string): URL {
  const base = API_BASE || window.location.origin;
  return new URL(path, base);
}

function ownerHeaders(ownerToken: string, headers?: HeadersInit): Headers {
  const next = new Headers(headers);
  if (ownerToken) next.set('authorization', `Bearer ${ownerToken}`);
  return next;
}

function ownerFetch(
  path: string | URL,
  ownerToken: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = typeof path === 'string' ? apiUrl(path) : path;
  return fetch(url, { ...init, headers: ownerHeaders(ownerToken, init.headers) });
}

function readDashboardResponse<T>(
  value: unknown,
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
  label: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid ${label} response`);
  return parsed.data as T;
}

/** Fetch an owner API URL and parse JSON, throwing on non-2xx so callers share one error path. */
async function loadOwnerJson(url: URL, ownerToken: string, signal?: AbortSignal): Promise<unknown> {
  const response = await ownerFetch(url, ownerToken, { signal });
  if (!response.ok) throw new Error(`API returned ${response.status}`);
  return response.json();
}

function readCapabilities(value: unknown): EnvironmentCapabilities {
  const parsed = EnvironmentCapabilitiesSchema.safeParse(value);
  if (
    !parsed.success ||
    !CAPABILITY_IDS.every((id) => parsed.data.capabilities.some((item) => item.id === id))
  )
    throw new Error('Capability status is incomplete');
  return parsed.data;
}

function useEnvironmentCapabilities(project: SavedProject, ownerToken: string) {
  const [data, setData] = useState<EnvironmentCapabilities | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    setData(null);
  }, [ownerToken, project]);

  useEffect(() => {
    let cancelled = false;
    setError('');
    setLoading(true);
    async function load(): Promise<void> {
      try {
        const url = scopedUrl('/v1/capabilities', project);
        const next = readCapabilities(await loadOwnerJson(url, ownerToken));
        if (!cancelled) {
          setData(next);
          setError('');
        }
      } catch (cause) {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : 'Capability status is unavailable');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    const stopPolling = pollWhileVisible(() => void load(), 10_000);
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [ownerToken, project, refresh]);

  async function save(enabled: CapabilityId[]): Promise<boolean> {
    setSaving(true);
    setError('');
    try {
      const url = scopedUrl('/v1/capabilities', project);
      const response = await ownerFetch(url, ownerToken, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!response.ok) throw new Error(`API returned ${response.status}`);
      setData(readCapabilities(await response.json()));
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save capabilities');
      return false;
    } finally {
      setSaving(false);
    }
  }

  return {
    data,
    error,
    loading,
    saving,
    reload: () => setRefresh((value) => value + 1),
    save,
  };
}

function readProject(): SavedProject | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<SavedProject>;
    if (!value.appId || !value.environmentId || !value.name || !value.environment) return null;
    return value as SavedProject;
  } catch {
    return null;
  }
}

function availableProjects(listed: ListAppsResponseV1): SavedProject[] {
  return listed.apps.flatMap((entry) =>
    entry.environments.map((environment) => ({
      appId: entry.app.id,
      environmentId: environment.id,
      name: entry.app.name,
      environment: environment.name,
    })),
  );
}

function authorizedProject(
  current: SavedProject | null,
  available: SavedProject[],
): SavedProject | null {
  if (!current) return available[0] ?? null;
  return (
    available.find(
      (candidate) =>
        candidate.appId === current.appId && candidate.environmentId === current.environmentId,
    ) ??
    available[0] ??
    null
  );
}

function requestedProjectFromLocation(): { appId: string; environmentId: string } | null {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('project') && !params.has('environment')) return null;
  return {
    appId: params.get('project')?.trim() ?? '',
    environmentId: params.get('environment')?.trim() ?? '',
  };
}

function projectUnavailableMessage(target: { appId: string; environmentId: string }): string {
  if (!target.appId || !target.environmentId)
    return 'This analytics link is incomplete. Choose a project from your workspace.';
  return 'This project is unavailable in the signed-in workspace. Choose a project from your workspace.';
}

function resolveInventorySelection(
  project: SavedProject | null,
  requestedProject: { appId: string; environmentId: string } | null,
  strictRequestedProject: boolean,
  available: SavedProject[],
): { selected: SavedProject | null; unavailableTarget: boolean } {
  if (!strictRequestedProject || !requestedProject)
    return { selected: authorizedProject(project, available), unavailableTarget: false };
  const selected =
    available.find(
      (candidate) =>
        candidate.appId === requestedProject.appId &&
        candidate.environmentId === requestedProject.environmentId,
    ) ?? null;
  return { selected, unavailableTarget: selected === null };
}

function sortValue(endpoint: EndpointAggregateV1, key: SortKey): number {
  if (key === 'health') return healthWeight[endpoint.health_state];
  if (key === 'requests') return endpoint.request_count;
  if (key === 'p95') return endpoint.p95_ms;
  if (key === 'error_rate') return endpoint.error_rate;
  return endpoint.last_seen ?? 0;
}

export function sortEndpoints(
  endpoints: EndpointAggregateV1[],
  key: SortKey,
  direction: SortDirection,
): EndpointAggregateV1[] {
  const factor = direction === 'desc' ? -1 : 1;
  return endpoints
    .map((endpoint, index) => ({ endpoint, index }))
    .sort((a, b) => {
      if (key !== 'last_seen' && a.endpoint.metrics_available !== b.endpoint.metrics_available) {
        return a.endpoint.metrics_available === false ? 1 : -1;
      }
      const av = sortValue(a.endpoint, key);
      const bv = sortValue(b.endpoint, key);
      return av === bv ? a.index - b.index : (av - bv) * factor;
    })
    .map(({ endpoint }) => endpoint);
}

function formatAge(timestamp: number | null): string {
  if (timestamp === null) return 'Never';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function methodClass(method: string): string {
  if (method === 'GET')
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400';
  if (method === 'POST')
    return 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400';
  if (method === 'DELETE') return 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400';
  return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400';
}

function healthClass(state: EndpointAggregateV1['health_state']): string {
  if (state === 'healthy')
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400';
  if (state === 'degraded')
    return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400';
  if (state === 'unhealthy') return 'border-destructive/30 bg-destructive/10 text-destructive';
  return 'border-border bg-muted text-muted-foreground';
}

export function OwnerUnlock({
  onUnlock,
  googleEnabled = false,
}: {
  onUnlock: (token: string, listed: ListAppsResponseV1) => void;
  googleEnabled?: boolean;
}): JSX.Element {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await ownerFetch('/v1/apps', token.trim());
      if (response.status === 403) throw new Error('That owner key was not accepted');
      if (!response.ok) throw new Error(`App Health returned ${response.status}`);
      onUnlock(token.trim(), (await response.json()) as ListAppsResponseV1);
      setToken('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not unlock App Health');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex h-16 max-w-6xl items-center px-4 sm:px-6">
          <ProductBrand />
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="mx-auto grid max-w-6xl gap-12 px-4 py-14 sm:px-6 sm:py-20 lg:grid-cols-[1.12fr_0.88fr] lg:items-center lg:py-28">
        <section aria-labelledby="unlock-title">
          <Badge variant="secondary" className="gap-2 font-medium">
            <Radio className="size-3.5" /> Private product workspace
          </Badge>
          <h1
            id="unlock-title"
            className="mt-6 max-w-3xl text-balance text-5xl font-semibold leading-[1.02] tracking-[-0.05em] sm:text-6xl"
          >
            Understand what people do—and what gets in their way.
          </h1>
          <p className="mt-6 max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
            Bring web traffic and intentional product events into one workspace, with application
            health nearby when the experience needs investigation.
          </p>
          <div className="mt-9 grid gap-3 sm:grid-cols-3" aria-label="Product capabilities">
            {[
              {
                Icon: BarChart3,
                label: 'Web analytics',
                copy: 'Page views, sources, and live sessions.',
              },
              {
                Icon: MousePointer2,
                label: 'Named events',
                copy: 'The product actions your team chooses to measure.',
              },
              {
                Icon: Activity,
                label: 'App health',
                copy: 'Route traffic, errors, latency, and logs.',
              },
            ].map(({ Icon, label, copy }) => (
              <Card key={label} className="bg-card/60 shadow-none">
                <CardContent className="p-4">
                  <Icon className="size-4 text-primary" />
                  <strong className="mt-4 block text-sm">{label}</strong>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{copy}</p>
                </CardContent>
              </Card>
            ))}
          </div>
          <div className="mt-8 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
            <Badge variant="outline" className="font-normal">
              Local analytics preview available
            </Badge>
            <a className="hover:text-foreground" href="/changelog">
              See what is shipped
            </a>
            <a
              className="inline-flex items-center gap-2 hover:text-foreground"
              href="https://github.com/sass-maker/app-health"
              aria-label="GitHub repository"
            >
              <GitHubIcon /> Source
            </a>
          </div>
        </section>
        <Card aria-label="Unlock App Health" className="border-border/80 shadow-xl">
          <CardHeader>
            <CardTitle className="text-2xl">Open your workspace</CardTitle>
            <p className="text-sm leading-6 text-muted-foreground">
              {googleEnabled
                ? 'Sign in to see your products and their analytics.'
                : 'Enter the owner key for this private deployment.'}
            </p>
          </CardHeader>
          <CardContent className="space-y-5">
            {googleEnabled ? <GoogleSignIn /> : null}
            {googleEnabled ? (
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="h-px flex-1 bg-border" /> existing deployment key
                <span className="h-px flex-1 bg-border" />
              </div>
            ) : null}
            <form className="space-y-4" onSubmit={(event) => void submit(event)}>
              <label className="grid gap-2 text-sm font-medium">
                Owner key
                <Input
                  autoComplete="current-password"
                  autoFocus={!googleEnabled}
                  maxLength={256}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder="aho_••••••••••••"
                  required
                  spellCheck={false}
                  type="password"
                  value={token}
                />
              </label>
              {error ? (
                <Alert variant="destructive">
                  <AlertTriangle />
                  <AlertTitle>Could not open the workspace</AlertTitle>
                  <AlertDescription>{error}. Check the key and try again.</AlertDescription>
                </Alert>
              ) : null}
              <Button className="h-11 w-full" disabled={submitting || !token.trim()} type="submit">
                {submitting ? 'Checking…' : 'Unlock'}
              </Button>
            </form>
            <p className="text-xs leading-5 text-muted-foreground">
              Your key stays in memory and clears when this page closes.
            </p>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

function Setup({
  ownerToken,
  onCreated,
}: {
  ownerToken: string;
  onCreated: (created: CreateAppResponseV1) => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState('production');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await ownerFetch('/v1/apps', ownerToken, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, environment, key_scope: 'environment' }),
      });
      if (!response.ok) throw new Error(`Setup API returned ${response.status}`);
      onCreated((await response.json()) as CreateAppResponseV1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create the app');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto grid max-w-6xl gap-8 px-4 py-8 sm:px-6 sm:py-14 lg:grid-cols-[1.1fr_0.9fr] lg:items-center lg:gap-12 lg:py-28">
      <section aria-labelledby="setup-title" className="order-2 lg:order-1">
        <Badge variant="secondary" className="gap-2 font-medium">
          <BarChart3 className="size-3.5" /> Add your product
        </Badge>
        <h1
          id="setup-title"
          className="mt-6 max-w-2xl text-balance text-5xl font-semibold leading-[1.02] tracking-[-0.05em] sm:text-6xl"
        >
          Start with a product you want to understand.
        </h1>
        <p className="mt-6 max-w-xl text-base leading-7 text-muted-foreground sm:text-lg">
          Create a project, add the browser tracker, and start with page views and the product
          actions your team cares about. Application health stays close when you need context.
        </p>
        <div className="mt-8 hidden gap-3 text-sm text-muted-foreground sm:grid sm:grid-cols-2">
          <span className="flex items-center gap-2 rounded-md border bg-card/60 p-3">
            <BarChart3 className="size-4 text-primary" /> Page views and sources
          </span>
          <span className="flex items-center gap-2 rounded-md border bg-card/60 p-3">
            <MousePointer2 className="size-4 text-primary" /> Named product events
          </span>
          <span className="flex items-center gap-2 rounded-md border bg-card/60 p-3">
            <Radio className="size-4 text-primary" /> Live sessions
          </span>
          <span className="flex items-center gap-2 rounded-md border bg-card/60 p-3">
            <Activity className="size-4 text-primary" /> Route and log context
          </span>
        </div>
      </section>
      <Card aria-label="Create an App Health project" className="order-1 shadow-xl lg:order-2">
        <CardHeader>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">
            Step 1 · Add a product
          </p>
          <CardTitle className="text-2xl">Create your project</CardTitle>
          <p className="text-sm leading-6 text-muted-foreground">
            Use the name your team knows. You can connect browser analytics after creation.
          </p>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={(event) => void submit(event)}>
            <label className="grid gap-2 text-sm font-medium">
              Application name
              <Input
                required
                maxLength={128}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="customer-portal"
                autoFocus
              />
            </label>
            <label className="grid gap-2 text-sm font-medium">
              Environment
              <Input
                required
                maxLength={64}
                value={environment}
                onChange={(event) => setEnvironment(event.target.value)}
              />
            </label>
            {error ? (
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertTitle>Setup failed</AlertTitle>
                <AlertDescription>{error}. Check the local API and try again.</AlertDescription>
              </Alert>
            ) : null}
            <Button className="h-11 w-full" disabled={submitting || !name.trim()} type="submit">
              {submitting ? 'Creating…' : 'Create project'}
            </Button>
          </form>
          <p className="mt-4 text-xs leading-5 text-muted-foreground">
            {import.meta.env.DEV
              ? 'Local preview · no cloud resources are created.'
              : 'Project keys are shown once. Save yours before continuing.'}
          </p>
        </CardContent>
      </Card>
    </main>
  );
}

function KeySetup({
  created,
  onDone,
}: {
  created: CreateAppResponseV1;
  onDone: () => void;
}): JSX.Element {
  type SetupRuntime = 'express' | 'hono' | 'pages' | 'echo' | 'otel';
  const [runtime, setRuntime] = useState<SetupRuntime>('express');
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<'key' | 'snippet' | null>(null);
  const key = created.key.key;
  const expressSnippet = `npm install https://github.com/sass-maker/app-health/releases/download/node-v0.3.0/saas-maker-app-health-0.3.0.tgz\n\nimport { createAppHealthClient } from '@saas-maker/app-health';\nimport { expressMiddleware } from '@saas-maker/app-health/express';\n\nconst appHealth = createAppHealthClient({\n  key: '${key}',\n  environment: ${JSON.stringify(created.environment.name)},\n  endpoint: '${INGEST_ORIGIN}/v1/ingest',\n});\n\napp.use(expressMiddleware({ client: appHealth }));`;
  const honoSnippet = `npm install https://github.com/sass-maker/app-health/releases/download/node-v0.3.0/saas-maker-app-health-0.3.0.tgz\n\nimport { createAppHealthClient } from '@saas-maker/app-health';\nimport { honoMiddleware } from '@saas-maker/app-health/hono';\n\nconst appHealth = createAppHealthClient({\n  key: '${key}',\n  environment: ${JSON.stringify(created.environment.name)},\n  endpoint: '${INGEST_ORIGIN}/v1/ingest',\n  runtime: 'worker',\n  disableTimer: true,\n});\n\napp.use('*', honoMiddleware({ client: appHealth }));`;
  const pagesSnippet = `npm install https://github.com/sass-maker/app-health/releases/download/node-v0.3.0/saas-maker-app-health-0.3.0.tgz\n\nimport { createAppHealthClient } from '@saas-maker/app-health';\nimport { withPagesFunctionHealth } from '@saas-maker/app-health/pages';\n\nconst appHealth = createAppHealthClient({\n  key: '${key}',\n  environment: ${JSON.stringify(created.environment.name)},\n  endpoint: '${INGEST_ORIGIN}/v1/ingest',\n  runtime: 'worker',\n  disableTimer: true,\n});\n\nexport const onRequestGet = withPagesFunctionHealth(\n  { client: appHealth, route: '/users/:id' },\n  async () => Response.json({ ok: true }),\n);`;
  const echoSnippet = `go get github.com/sarthakagrawal927/app-health/packages/go/echo/v5@v5.1.0\n\nimport apphealthechov5 "github.com/sarthakagrawal927/app-health/packages/go/echo/v5"\n\ncleanup := apphealthechov5.Install(e, apphealthechov5.Config{\n  Enabled: true,\n  Environment: ${JSON.stringify(created.environment.name)},\n  Key: ${JSON.stringify(key)},\n  Project: ${JSON.stringify(created.app.name)},\n})\ndefer cleanup()`;
  const otelSnippet = `processors:\n  resource/app_health:\n    attributes:\n      - key: deployment.environment.name\n        value: ${JSON.stringify(created.environment.name)}\n        action: upsert\n\nexporters:\n  otlphttp/app_health:\n    traces_endpoint: '${INGEST_ORIGIN}/v1/traces'\n    headers:\n      Authorization: 'Bearer ${key}'\n\nservice:\n  pipelines:\n    traces:\n      # Keep your current receivers and processors.\n      processors: [your_existing_processors, resource/app_health]\n      exporters: [your_existing_exporter, otlphttp/app_health]`;
  const snippets: Record<SetupRuntime, string> = {
    express: expressSnippet,
    hono: honoSnippet,
    pages: pagesSnippet,
    echo: echoSnippet,
    otel: otelSnippet,
  };

  async function copy(value: string, label: 'key' | 'snippet'): Promise<void> {
    setCopyError(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(value);
      setCopied(label);
    } catch {
      setCopied(null);
      setCopyError(label);
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex h-16 max-w-5xl items-center px-4 sm:px-6">
          <ProductBrand />
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl space-y-6 px-4 py-10 sm:px-6 sm:py-14">
        <div className="flex items-start gap-4">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="size-5" />
          </span>
          <div>
            <Badge variant="secondary">Project ready</Badge>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight">
              Save the application health key
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              This server key is shown once. Save it if you want route and latency context; browser
              analytics setup comes next.
            </p>
          </div>
        </div>
        <Card className="shadow-none">
          <CardContent className="space-y-4 p-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-muted-foreground">Ingest key</p>
                <code className="mt-2 block break-all rounded-md bg-muted p-3 text-xs">{key}</code>
              </div>
              <Button variant="outline" onClick={() => void copy(key, 'key')}>
                {copied === 'key' ? 'Copied' : 'Copy key'}
              </Button>
            </div>
            {copyError === 'key' ? <CopyFallback subject="key" /> : null}
          </CardContent>
        </Card>
        <div className="flex justify-end">
          <Button size="lg" onClick={onDone}>
            Save key and choose capabilities
          </Button>
        </div>
        <Card className="overflow-hidden shadow-none">
          <Tabs value={runtime} onValueChange={(value) => setRuntime(value as typeof runtime)}>
            <CardHeader className="border-b">
              <CardTitle className="text-base">Optional application health setup</CardTitle>
              <p className="text-sm text-muted-foreground">
                Choose the runtime behind this product to add route, latency, and error context.
              </p>
              <TabsList
                aria-label="Ingestion source"
                className="mt-3 h-auto flex-wrap justify-start"
              >
                <TabsTrigger value="express" onClick={() => setRuntime('express')}>
                  Express
                </TabsTrigger>
                <TabsTrigger value="hono" onClick={() => setRuntime('hono')}>
                  Hono Worker
                </TabsTrigger>
                <TabsTrigger value="pages" onClick={() => setRuntime('pages')}>
                  Pages Functions
                </TabsTrigger>
                <TabsTrigger value="echo" onClick={() => setRuntime('echo')}>
                  Go + Echo
                </TabsTrigger>
                <TabsTrigger value="otel" onClick={() => setRuntime('otel')}>
                  Existing OpenTelemetry
                </TabsTrigger>
              </TabsList>
            </CardHeader>
            <CardContent className="pt-5">
              {(Object.entries(snippets) as [SetupRuntime, string][]).map(
                ([value, currentSnippet]) => (
                  <TabsContent key={value} value={value} className="mt-0 space-y-4">
                    <pre className="max-h-[32rem] overflow-auto rounded-lg bg-zinc-950 p-4 text-xs leading-6 text-zinc-100">
                      <code>{currentSnippet}</code>
                    </pre>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <p className="text-xs text-muted-foreground">
                        {value === 'otel'
                          ? 'Reload your Collector and send one traced request to a server route.'
                          : 'Run your application and make one request to any route.'}
                      </p>
                      <Button
                        variant="outline"
                        onClick={() => void copy(currentSnippet, 'snippet')}
                      >
                        {copied === 'snippet' ? 'Copied snippet' : 'Copy snippet'}
                      </Button>
                    </div>
                    {copyError === 'snippet' ? <CopyFallback subject="snippet" /> : null}
                  </TabsContent>
                ),
              )}
            </CardContent>
          </Tabs>
        </Card>
      </main>
    </div>
  );
}

function CopyFallback({ subject }: { subject: 'key' | 'snippet' }): JSX.Element {
  return (
    <Alert variant="destructive">
      <AlertTriangle />
      <AlertTitle>Automatic copy unavailable</AlertTitle>
      <AlertDescription>
        Select the {subject} above and copy it manually. The value remains visible on this page.
      </AlertDescription>
    </Alert>
  );
}

function connectedTitle(runtime: Runtime | undefined): string {
  if (runtime === 'otel') return 'OpenTelemetry connected';
  if (runtime === 'worker') return 'Cloudflare Worker connected';
  return 'SDK connected';
}

function connectedRuntimeLabel(runtime: Runtime | undefined): string {
  if (runtime === 'node') return 'Node.js';
  if (runtime === 'worker') return 'Cloudflare Worker';
  if (runtime === 'go') return 'Go';
  return 'Your OpenTelemetry pipeline';
}

function connectedMessage(runtime: Runtime | undefined): string {
  return runtime
    ? `${connectedRuntimeLabel(runtime)} is sending endpoint summaries.`
    : 'Endpoint summaries are arriving.';
}

function statusBannerCopy(status: InstallationStatusV1): [string, string] {
  if (status.state === 'waiting')
    return [
      'Waiting for traffic',
      'Start your service and make one request. This page checks automatically.',
    ];
  if (status.state === 'connected')
    return [connectedTitle(status.runtime), connectedMessage(status.runtime)];
  if (status.state === 'stale')
    return [
      'Traffic has gone quiet',
      'This source connected before, but no recent events arrived. Check that your service is running.',
    ];
  if (status.state === 'revoked')
    return [
      'Ingest key revoked',
      'Create a fresh project key before this service can send more endpoint summaries.',
    ];
  return [
    'Installation check unavailable',
    'The metrics API could not verify this installation. Your application remains unaffected.',
  ];
}

function StatusBanner({
  status,
  fixture,
}: {
  status: InstallationStatusV1;
  fixture: boolean;
}): JSX.Element {
  const [title, message] = fixture
    ? [
        'Sample data',
        'These metrics are seeded fixtures, not traffic received from an SDK. Create a project to verify your own service.',
      ]
    : statusBannerCopy(status);
  const stateClass =
    status.state === 'connected'
      ? 'border-emerald-500/25 bg-emerald-500/5'
      : status.state === 'waiting'
        ? 'border-primary/25 bg-primary/5'
        : 'border-amber-500/25 bg-amber-500/5';
  const Icon = status.state === 'connected' ? CheckCircle2 : Clock3;
  return (
    <Alert aria-live="polite" className={stateClass}>
      <Icon aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="sm:flex-row sm:items-center sm:justify-between">
        <p>{message}</p>
        {status.state === 'waiting' ? (
          <Badge variant="outline" className="w-fit font-normal">
            Checking every 10s
          </Badge>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

function EndpointTableRow({ endpoint }: { endpoint: EndpointAggregateV1 }): JSX.Element {
  const hasMetrics = endpoint.metrics_available !== false;
  const sampled = endpoint.upstream_sampled || endpoint.sampled;
  return (
    <TableRow>
      <TableCell>
        <Badge variant="outline" className={methodClass(endpoint.method)}>
          {endpoint.method}
        </Badge>
      </TableCell>
      <TableCell>
        <div className="grid gap-1">
          <code className="text-xs font-medium">{endpoint.route}</code>
          {sampled ? (
            <span className="text-xs text-muted-foreground">
              {endpoint.upstream_sampled ? 'OTel sampled estimate' : 'Sampled estimate'}
            </span>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="tabular-nums">
        {hasMetrics ? endpoint.request_count.toLocaleString() : '—'}
      </TableCell>
      <TableCell
        className={`tabular-nums ${hasMetrics && endpoint.error_rate >= 0.01 ? 'text-destructive' : ''}`}
      >
        {hasMetrics ? `${(endpoint.error_rate * 100).toFixed(1)}%` : '—'}
      </TableCell>
      <TableCell className="tabular-nums">{hasMetrics ? `${endpoint.p50_ms} ms` : '—'}</TableCell>
      <TableCell className="tabular-nums">{hasMetrics ? `${endpoint.p95_ms} ms` : '—'}</TableCell>
      <TableCell className="text-muted-foreground">{formatAge(endpoint.last_seen)}</TableCell>
      <TableCell>
        <Badge variant="outline" className={healthClass(endpoint.health_state)}>
          {hasMetrics ? endpoint.health_state.replace('-', ' ') : 'metrics unavailable'}
        </Badge>
      </TableCell>
    </TableRow>
  );
}

function EndpointCard({ endpoint }: { endpoint: EndpointAggregateV1 }): JSX.Element {
  const hasMetrics = endpoint.metrics_available !== false;
  const sampled = endpoint.upstream_sampled || endpoint.sampled;
  return (
    <Card className="shadow-none">
      <CardHeader className="flex flex-row items-start justify-between gap-3 border-b pb-4">
        <div>
          <Badge variant="outline" className={methodClass(endpoint.method)}>
            {endpoint.method}
          </Badge>
          <div className="mt-2 grid gap-1">
            <code className="break-all text-xs font-medium">{endpoint.route}</code>
            {sampled ? (
              <span className="text-xs text-muted-foreground">
                {endpoint.upstream_sampled ? 'OTel sampled estimate' : 'Sampled estimate'}
              </span>
            ) : null}
          </div>
        </div>
        <Badge variant="outline" className={healthClass(endpoint.health_state)}>
          {hasMetrics ? endpoint.health_state.replace('-', ' ') : 'metrics unavailable'}
        </Badge>
      </CardHeader>
      <CardContent className="pt-4">
        <dl className="grid grid-cols-2 gap-4">
          {[
            ['Requests', hasMetrics ? endpoint.request_count.toLocaleString() : '—'],
            ['Error rate', hasMetrics ? `${(endpoint.error_rate * 100).toFixed(1)}%` : '—'],
            ['p50', hasMetrics ? `${endpoint.p50_ms} ms` : '—'],
            ['p95', hasMetrics ? `${endpoint.p95_ms} ms` : '—'],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="mt-1 text-sm font-medium tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 border-t pt-3 text-xs text-muted-foreground">
          Last seen {formatAge(endpoint.last_seen)}
        </p>
      </CardContent>
    </Card>
  );
}

function TimeWindowControl({
  value,
  onChange,
}: {
  value: Window;
  onChange: (value: Window) => void;
}) {
  return (
    <div
      className="inline-flex rounded-lg border bg-card p-1"
      role="group"
      aria-label="Time window"
    >
      {WINDOWS.map((window) => (
        <Button
          key={window}
          size="sm"
          variant={value === window ? 'secondary' : 'ghost'}
          aria-pressed={value === window}
          onClick={() => onChange(window)}
        >
          {window}
        </Button>
      ))}
    </div>
  );
}

function EndpointHealth({
  project,
  status,
  error,
  loading,
  endpoints,
  sortKey,
  sortDirection,
  onSort,
}: {
  project: SavedProject;
  status: InstallationStatusV1 | null;
  error: string | null;
  loading: boolean;
  endpoints: EndpointAggregateV1[];
  sortKey: SortKey;
  sortDirection: SortDirection;
  onSort: (key: SortKey) => void;
}): JSX.Element {
  const columns = [
    ['requests', 'Requests'],
    ['error_rate', 'Error rate'],
    ['p95', 'p50'],
    ['p95', 'p95'],
    ['last_seen', 'Last seen'],
    ['health', 'Health'],
  ] as [SortKey, string][];
  return (
    <div className="space-y-5">
      {error ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Can’t refresh endpoint data</AlertTitle>
          <AlertDescription className="sm:flex-row sm:items-center sm:justify-between">
            <p>{error}. Your application is unaffected; the SDK fails open.</p>
            <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {status ? (
        <StatusBanner
          status={status}
          fixture={import.meta.env.DEV && project.appId === SEED_APP_ID}
        />
      ) : null}
      <Card className="overflow-hidden shadow-none" aria-busy={loading}>
        <CardHeader className="flex flex-row items-end justify-between gap-4 border-b">
          <div>
            <CardTitle className="text-base">Observed endpoints</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">{endpoints.length} observed</p>
          </div>
          <div className="grid gap-1.5 text-xs font-medium text-muted-foreground">
            <span>Sort by</span>
            <Select value={sortKey} onValueChange={(value) => onSort(value as SortKey)}>
              <SelectTrigger aria-label="Sort endpoints" className="w-40 bg-background">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="health">Health</SelectItem>
                <SelectItem value="requests">Requests</SelectItem>
                <SelectItem value="error_rate">Error rate</SelectItem>
                <SelectItem value="p95">p95 latency</SelectItem>
                <SelectItem value="last_seen">Last seen</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loading && endpoints.length === 0 ? (
            <div className="space-y-2 p-4" aria-label="Loading endpoints">
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </div>
          ) : null}
          {!loading && !error && endpoints.length === 0 ? (
            <Alert className="m-4 w-auto">
              <Activity />
              <AlertTitle>No endpoints observed yet</AlertTitle>
              <AlertDescription>
                <p>
                  Start {project.name}, then make a request to any route. It will appear here within
                  a few seconds.
                </p>
                <code className="mt-3 inline-block rounded-md bg-muted px-3 py-2 text-xs text-foreground">
                  curl http://localhost:3000/health
                </code>
              </AlertDescription>
            </Alert>
          ) : null}
          {endpoints.length > 0 ? (
            <>
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Method</TableHead>
                      <TableHead>Route</TableHead>
                      {columns.map(([key, label]) => (
                        <TableHead key={`${key}-${label}`}>
                          <button
                            className="inline-flex items-center gap-1"
                            onClick={() => onSort(key)}
                          >
                            {label}
                            {sortKey === key ? (
                              <span
                                aria-label={sortDirection === 'desc' ? 'descending' : 'ascending'}
                              >
                                {sortDirection === 'desc' ? '↓' : '↑'}
                              </span>
                            ) : null}
                          </button>
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {endpoints.map((endpoint) => (
                      <EndpointTableRow
                        key={`${endpoint.method}|${endpoint.route}`}
                        endpoint={endpoint}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="grid gap-3 p-4 md:hidden">
                {endpoints.map((endpoint) => (
                  <EndpointCard key={`${endpoint.method}|${endpoint.route}`} endpoint={endpoint} />
                ))}
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-sm">How health is decided</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-xs text-muted-foreground sm:grid-cols-2 xl:grid-cols-4">
          <p>
            <strong className="text-emerald-700 dark:text-emerald-400">Healthy</strong>
            <br />
            under {DEGRADED_ERROR_RATE * 100}% errors and {DEGRADED_P95_MS / 1000}s p95
          </p>
          <p>
            <strong className="text-amber-700 dark:text-amber-400">Degraded</strong>
            <br />
            at least {DEGRADED_ERROR_RATE * 100}% errors or {DEGRADED_P95_MS / 1000}s p95
          </p>
          <p>
            <strong className="text-destructive">Unhealthy</strong>
            <br />
            at least {UNHEALTHY_ERROR_RATE * 100}% errors or {UNHEALTHY_P95_MS / 1000}s p95
          </p>
          <p>
            <strong className="text-foreground">Low volume</strong>
            <br />
            under {INSUFFICIENT_DATA_MIN_REQUESTS} requests
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

const receivedFields = [
  ['batch_id', 'Retry deduplication', 'Short-lived', 'Eligible for cleanup after 1 hour'],
  ['schema_version', 'Contract validation', 'Not stored', 'Discarded after validation'],
  ['runtime', 'SDK and installation state', 'Latest + aggregate', 'Node, Worker, Go, or OTel'],
  ['release', 'Release comparison', 'Aggregate / failure', 'Failure value expires after 24 hours'],
  ['event_id', 'Failure identity', 'Failures only', 'Queryable for 24 hours'],
  ['timestamp', 'Windowing and freshness', 'Aggregate / inventory / failure', 'No request content'],
  ['method', 'Endpoint identity', 'Inventory + aggregate + failure', 'Uppercase HTTP method'],
  ['route', 'Endpoint identity', 'Inventory + aggregate + failure', 'Normalized template only'],
  [
    'status_code',
    'Counts and error classification',
    'Aggregate / failure',
    'Exact only for 4xx/5xx',
  ],
  ['duration_ms', 'Latency histogram', 'Aggregate / failure', 'Exact only for 4xx/5xx'],
] as const;

const excludedFields = [
  'Request bodies',
  'Response bodies',
  'Headers',
  'Cookies',
  'Query values',
  'Route parameter values',
  'User identity',
  'Logs and stack traces',
];

function formatTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(timestamp));
}

function FailureDetail({
  failure,
  detailId,
}: {
  failure: FailureEventV1;
  detailId: string;
}): JSX.Element {
  return (
    <TableRow className="bg-muted/25 hover:bg-muted/25">
      <TableCell colSpan={7} className="whitespace-normal p-4 sm:p-5">
        <div id={detailId} className="rounded-lg border bg-card p-4 sm:p-5">
          <div>
            <strong className="block text-sm">Retained failure detail</strong>
            <span className="mt-1 block text-xs text-muted-foreground">
              Exact fields kept for this failed request
            </span>
          </div>
          <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">Endpoint</dt>
              <dd className="mt-1 text-sm">
                <code className="break-all">
                  {failure.method} {failure.route}
                </code>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Status</dt>
              <dd className="mt-1 text-sm font-medium">{failure.status_code}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Duration</dt>
              <dd className="mt-1 text-sm font-medium">
                {failure.duration_ms.toLocaleString()} ms
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Occurred</dt>
              <dd className="mt-1 text-sm">
                <time dateTime={new Date(failure.occurred_at).toISOString()}>
                  {formatTimestamp(failure.occurred_at)}
                </time>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Release</dt>
              <dd className="mt-1 text-sm">{failure.release ?? 'Not reported'}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">Failure ID</dt>
              <dd className="mt-1 text-sm">
                <code className="break-all">{failure.failure_id}</code>
              </dd>
            </div>
          </dl>
          <p className="mt-4 border-t pt-4 text-xs leading-5 text-muted-foreground">
            No request body, headers, query values, route values, identity, logs, or stack traces
            were collected.
          </p>
        </div>
      </TableCell>
    </TableRow>
  );
}

function FailureRow({ failure }: { failure: FailureEventV1 }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const detailId = `failure-detail-${failure.failure_id}`;
  const endpointLabel = `${failure.method} ${failure.route} ${failure.status_code}`;

  return (
    <>
      <TableRow aria-expanded={expanded}>
        <TableCell>
          <Badge variant="outline" className={methodClass(failure.method)}>
            {failure.method}
          </Badge>
        </TableCell>
        <TableCell>
          <code className="text-xs font-medium">{failure.route}</code>
        </TableCell>
        <TableCell>
          <Badge variant={failure.status_code >= 500 ? 'destructive' : 'secondary'}>
            {failure.status_code}
          </Badge>
        </TableCell>
        <TableCell className="tabular-nums">{failure.duration_ms.toLocaleString()} ms</TableCell>
        <TableCell className="text-muted-foreground" title={formatTimestamp(failure.occurred_at)}>
          {formatAge(failure.occurred_at)}
        </TableCell>
        <TableCell>{failure.release ?? '—'}</TableCell>
        <TableCell>
          <code className="block max-w-32 truncate text-xs" title={failure.failure_id}>
            {failure.failure_id}
          </code>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="mt-1 h-auto p-0 text-xs"
            aria-expanded={expanded}
            aria-controls={detailId}
            aria-label={`${expanded ? 'Hide' : 'View'} details for ${endpointLabel}`}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? 'Hide details' : 'View details'}
          </Button>
        </TableCell>
      </TableRow>
      {expanded ? <FailureDetail failure={failure} detailId={detailId} /> : null}
    </>
  );
}

function DataReceived({
  project,
  ownerToken,
  windowKey,
}: {
  project: SavedProject;
  ownerToken: string;
  windowKey: Window;
}): JSX.Element {
  const [data, setData] = useState<FailureQueryResponseV1 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      setLoading(true);
      try {
        const url = apiUrl('/v1/failures');
        url.searchParams.set('app_id', project.appId);
        url.searchParams.set('environment_id', project.environmentId);
        url.searchParams.set('window', windowKey);
        url.searchParams.set('limit', '50');
        const next = (await loadOwnerJson(url, ownerToken)) as FailureQueryResponseV1;
        if (!cancelled) {
          setData(next);
          setError(null);
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Could not load retained failures');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [ownerToken, project, refresh, windowKey]);

  return (
    <div className="space-y-5">
      <Card aria-labelledby="trust-statement-title" className="shadow-none">
        <CardHeader className="flex flex-col gap-5 sm:flex-row sm:items-start">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ShieldCheck className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <CardTitle id="trust-statement-title" className="text-xl">
              Every request counts. Only failures leave a row.
            </CardTitle>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
              2xx and 3xx requests are folded into counts and fixed latency buckets, then their
              individual events are discarded. 4xx and 5xx details remain queryable for 24 hours.
            </p>
          </div>
          <div className="grid shrink-0 grid-cols-3 gap-2" aria-label="Retention summary">
            {[
              ['10', 'accepted fields'],
              ['0', 'payload fields'],
              ['24h', 'max retention'],
            ].map(([value, label]) => (
              <div key={label} className="rounded-md border bg-muted/40 px-3 py-2 text-center">
                <strong className="block text-sm tabular-nums">{value}</strong>
                <span className="text-xs text-muted-foreground">{label}</span>
              </div>
            ))}
          </div>
        </CardHeader>
      </Card>

      <Card aria-busy={loading} className="overflow-hidden shadow-none">
        <CardHeader className="flex flex-row items-center justify-between gap-4 border-b">
          <div>
            <CardTitle className="text-base">Latest retained failures</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              {data?.failures.length ?? 0} of up to 50 shown
              {data ? ` · refreshed ${formatAge(data.refreshed_at)}` : ''}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setRefresh((value) => value + 1)}>
            <RefreshCw className={loading ? 'animate-spin' : ''} />
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {error ? (
            <Alert variant="destructive" className="m-4 w-auto">
              <AlertTriangle />
              <AlertTitle>Failure details are unavailable</AlertTitle>
              <AlertDescription className="sm:flex-row sm:items-center sm:justify-between">
                <p>{error}. Collection policy and aggregate metrics are unchanged.</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setRefresh((value) => value + 1)}
                >
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
          {loading && !data ? (
            <div className="space-y-2 p-4" aria-label="Loading recent failures">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          ) : null}
          {!loading && !error && data?.failures.length === 0 ? (
            <Alert className="m-4 w-auto border-emerald-500/25 bg-emerald-500/5">
              <CheckCircle2 className="text-emerald-700 dark:text-emerald-400" />
              <AlertTitle>No retained failures in the last {WINDOW_LABELS[windowKey]}</AlertTitle>
              <AlertDescription>
                There are no individual 4xx or 5xx rows in this period. Choose a longer period or
                check App health for the complete aggregate traffic picture.
              </AlertDescription>
            </Alert>
          ) : null}
          {data && data.failures.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Method</TableHead>
                  <TableHead>Normalized route</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Occurred</TableHead>
                  <TableHead>Release</TableHead>
                  <TableHead>Failure ID</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.failures.map((failure) => (
                  <FailureRow key={failure.failure_id} failure={failure} />
                ))}
              </TableBody>
            </Table>
          ) : null}
        </CardContent>
      </Card>

      <Card aria-labelledby="field-ledger-title" className="overflow-hidden shadow-none">
        <CardHeader className="border-b">
          <CardTitle id="field-ledger-title" className="text-base">
            The complete accepted shape
          </CardTitle>
          <p className="text-sm leading-6 text-muted-foreground">
            Unknown fields make the entire batch fail validation. App Health does not silently
            accept extra request data.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Field</TableHead>
                <TableHead>Why it arrives</TableHead>
                <TableHead>Where it remains</TableHead>
                <TableHead>Boundary</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {receivedFields.map(([field, purpose, destination, boundary]) => (
                <TableRow key={field}>
                  <TableCell>
                    <code className="text-xs">{field}</code>
                  </TableCell>
                  <TableCell className="whitespace-normal">{purpose}</TableCell>
                  <TableCell className="whitespace-normal">{destination}</TableCell>
                  <TableCell className="whitespace-normal text-muted-foreground">
                    {boundary}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card aria-labelledby="excluded-data-title" className="shadow-none">
        <CardHeader className="flex flex-row items-start gap-4">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <EyeOff className="size-5" />
          </span>
          <div>
            <CardTitle id="excluded-data-title" className="text-base">
              Never collected
            </CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              These fields are absent from the SDK contract and rejected by the ingest validator.
            </p>
          </div>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-wrap gap-2">
            {excludedFields.map((field) => (
              <li key={field}>
                <Badge variant="secondary" className="font-normal">
                  {field}
                </Badge>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card className="shadow-none">
        <CardContent className="flex gap-3 p-4 text-xs leading-5 text-muted-foreground">
          <Database className="mt-0.5 size-4 shrink-0" />
          <p>
            Contract v1 is enforced by the ingest validator. Raw ingest keys are shown once; only a
            non-reversible verifier is stored. Batch IDs stop participating in deduplication after
            one hour. Failure rows stop being queryable after 24 hours and are queued for hourly
            deletion.{' '}
            <a
              className="font-medium text-foreground underline underline-offset-4"
              href="https://github.com/sass-maker/app-health/blob/main/packages/contracts/src/event.ts"
              target="_blank"
              rel="noopener noreferrer"
            >
              Inspect the source contract
            </a>
            .
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

const LEVEL_FILTER_LABELS: Record<LogLevel, string> = {
  debug: 'All levels',
  info: 'Info and above',
  warn: 'Warn and above',
  error: 'Errors only',
};

const LEVEL_ICONS: Record<LogLevel, string> = { debug: '🔍', info: '🔔', warn: '⚠️', error: '🚨' };

function formatPropValue(value: StoredLogV1['props'][string]): string {
  return value === null ? 'null' : String(value);
}

function LogRow({ log }: { log: StoredLogV1 }): JSX.Element {
  const props = Object.entries(log.props);
  return (
    <TableRow>
      <TableCell>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant={log.level === 'error' ? 'destructive' : 'secondary'}>{log.level}</Badge>
          {log.source !== 'server' ? <Badge variant="outline">{log.source}</Badge> : null}
        </div>
      </TableCell>
      <TableCell>
        <span className="mr-2" aria-hidden="true">
          {log.icon ?? LEVEL_ICONS[log.level]}
        </span>
        <code className="text-xs font-medium">{log.event}</code>
      </TableCell>
      <TableCell className="min-w-64 whitespace-normal">
        {log.title ? <strong className="block text-sm">{log.title}</strong> : null}
        {log.description ? (
          <p className="text-sm text-muted-foreground">{log.description}</p>
        ) : null}
        {props.length > 0 ? (
          <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Properties">
            {props.map(([key, value]) => (
              <li key={key} className="rounded bg-muted px-2 py-1 text-xs">
                <b>{key}</b> {formatPropValue(value)}
              </li>
            ))}
          </ul>
        ) : null}
      </TableCell>
      <TableCell className="text-muted-foreground" title={formatTimestamp(log.timestamp)}>
        {formatAge(log.timestamp)}
      </TableCell>
    </TableRow>
  );
}

function LogsSurface({
  data,
  error,
  loading,
  onRefresh,
}: {
  data: LogQueryResponseV1 | null;
  error: string | null;
  loading: boolean;
  onRefresh: () => void;
}): JSX.Element {
  return (
    <CardContent className="p-0">
      {error ? (
        <Alert variant="destructive" className="m-4 w-auto">
          <AlertTriangle />
          <AlertTitle>Logs are unavailable</AlertTitle>
          <AlertDescription className="sm:flex-row sm:items-center sm:justify-between">
            <p>{error}. Your application is unaffected; log delivery fails open.</p>
            <Button variant="outline" size="sm" onClick={onRefresh}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {loading && !data ? (
        <div className="space-y-2 p-4" aria-label="Loading logs">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : null}
      {!loading && !error && data?.logs.length === 0 ? (
        <Alert className="m-4 w-auto">
          <Activity />
          <AlertTitle>No logs match</AlertTitle>
          <AlertDescription>
            Send one from your app with <code>appHealth.log(&apos;signup&apos;, …)</code> or POST a
            batch to <code>/v1/logs</code> with your ingest key. It appears here within seconds.
          </AlertDescription>
        </Alert>
      ) : null}
      {data && data.logs.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Level</TableHead>
              <TableHead>Event</TableHead>
              <TableHead>Detail</TableHead>
              <TableHead>When</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.logs.map((log) => (
              <LogRow key={log.log_id} log={log} />
            ))}
          </TableBody>
        </Table>
      ) : null}
    </CardContent>
  );
}

/** Owner API URL scoped to the selected app and environment. */
function scopedUrl(path: string, project: SavedProject): URL {
  const url = apiUrl(path);
  url.searchParams.set('app_id', project.appId);
  url.searchParams.set('environment_id', project.environmentId);
  return url;
}

interface LogsFilters {
  level: LogLevel;
  source: LogSource | '';
  event: string;
}

interface LogsResult {
  data: LogQueryResponseV1 | null;
  error: string | null;
  loading: boolean;
}

function LogsView({
  project,
  ownerToken,
}: {
  project: SavedProject;
  ownerToken: string;
}): JSX.Element {
  const [filters, setFilters] = useState<LogsFilters>({ level: 'debug', source: '', event: '' });
  const [result, setResult] = useState<LogsResult>({ data: null, error: null, loading: true });
  const [refresh, setRefresh] = useState(0);
  const previousQuery = useRef('');

  useEffect(() => {
    let cancelled = false;
    const url = scopedUrl('/v1/logs', project);
    url.searchParams.set('level', filters.level);
    if (filters.source) url.searchParams.set('source', filters.source);
    if (filters.event) url.searchParams.set('event', filters.event);
    url.searchParams.set('limit', '200');
    const changed = previousQuery.current !== url.href;
    previousQuery.current = url.href;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    setResult((previous) => ({ data: changed ? null : previous.data, error: null, loading: true }));
    loadOwnerJson(url, ownerToken, controller.signal)
      .then((data) => {
        const parsed = readDashboardResponse(data, LogQueryResponseV1Schema, 'logs');
        if (!cancelled && !controller.signal.aborted)
          setResult({ data: parsed, error: null, loading: false });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        const error = cause instanceof Error ? cause.message : 'Could not load logs';
        setResult((previous) => ({ ...previous, error, loading: false }));
      })
      .finally(() => window.clearTimeout(timeout));
    const stopPolling = pollWhileVisible(() => setRefresh((value) => value + 1), 10_000);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timeout);
      stopPolling();
    };
  }, [ownerToken, project, filters, refresh]);

  const { data, error, loading } = result;
  const bump = () => setRefresh((value) => value + 1);
  return (
    <div className="space-y-5" aria-busy={loading}>
      <Card className="overflow-hidden shadow-none">
        <LogsToolbar
          data={data}
          loading={loading}
          filters={filters}
          onFilters={setFilters}
          onRefresh={bump}
        />
        <LogsSurface data={data} error={error} loading={loading} onRefresh={bump} />
      </Card>
      <PublicKeysPanel project={project} ownerToken={ownerToken} purpose="logs" />
    </div>
  );
}

function LogsToolbar({
  data,
  loading,
  filters,
  onFilters,
  onRefresh,
}: {
  data: LogQueryResponseV1 | null;
  loading: boolean;
  filters: LogsFilters;
  onFilters: (update: (previous: LogsFilters) => LogsFilters) => void;
  onRefresh: () => void;
}): JSX.Element {
  return (
    <CardHeader className="gap-5 border-b lg:flex-row lg:items-end lg:justify-between">
      <div>
        <CardTitle className="text-base">Application logs</CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">
          {data?.logs.length ?? 0} shown · kept {data?.retention_days ?? 30} days
          {data ? ` · refreshed ${formatAge(data.refreshed_at)}` : ''}
        </p>
      </div>
      <form
        className="grid gap-3 sm:grid-cols-2 lg:flex lg:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          const next = String(new FormData(event.currentTarget).get('event') ?? '').trim();
          onFilters((previous) => ({ ...previous, event: next }));
        }}
      >
        <div className="grid gap-1.5 text-xs font-medium text-muted-foreground">
          <span>Level</span>
          <Select
            value={filters.level}
            onValueChange={(value) =>
              onFilters((previous) => ({ ...previous, level: value as LogLevel }))
            }
          >
            <SelectTrigger aria-label="Minimum level" className="w-full bg-background lg:w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LOG_LEVELS.map((value) => (
                <SelectItem key={value} value={value}>
                  {LEVEL_FILTER_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5 text-xs font-medium text-muted-foreground">
          <span>Source</span>
          <Select
            value={filters.source || 'all'}
            onValueChange={(value) =>
              onFilters((previous) => ({
                ...previous,
                source: value === 'all' ? '' : (value as LogSource),
              }))
            }
          >
            <SelectTrigger aria-label="Source" className="w-full bg-background lg:w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sources</SelectItem>
              {LOG_SOURCES.map((value) => (
                <SelectItem key={value} value={value}>
                  {value === 'server'
                    ? 'Server only'
                    : value === 'native'
                      ? 'Native only'
                      : 'Browser only'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
          Event
          <Input
            name="event"
            aria-label="Event name"
            placeholder="signup"
            defaultValue={filters.event}
            className="h-10"
          />
        </label>
        <Button type="submit" variant="outline" size="sm" className="h-10">
          Apply
        </Button>
        <Button type="button" variant="outline" size="sm" className="h-10" onClick={onRefresh}>
          <RefreshCw className={loading ? 'animate-spin' : ''} />
          {loading ? 'Refreshing…' : 'Refresh'}
        </Button>
      </form>
    </CardHeader>
  );
}

interface PublicKeysState {
  keys: PublicLogKeyV1[];
  created: CreatePublicLogKeyResponseV1 | null;
  error: string | null;
}

type BrowserKeyPurpose = 'analytics' | 'logs' | 'combined';

const BROWSER_KEY_COPY: Record<BrowserKeyPurpose, { intro: string; summary: string }> = {
  analytics: {
    intro:
      'Create an origin-bound public key, then install the generated tracker on your website. It records page views and active browser sessions; your code sends only the named events you choose.',
    summary: 'Browser tracker keys',
  },
  logs: {
    intro:
      'Create an origin-bound public key for explicit browser logs. Use it for client errors and product moments that your server cannot observe.',
    summary: 'Browser logging keys',
  },
  combined: {
    intro:
      'Create an origin-bound public key for browser analytics or explicit browser logs. The key is safe to ship only from the origins you allow.',
    summary: 'Public browser keys',
  },
};

const parseOrigins = (value: string): string[] =>
  value
    .split(/[\s,]+/)
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);

interface PublicKeysPanelProps {
  project: SavedProject;
  ownerToken: string;
  installMode?: boolean;
  eyebrow?: string;
  title?: string;
  purpose?: BrowserKeyPurpose;
}

function PublicKeysPanel(props: PublicKeysPanelProps): JSX.Element {
  const {
    project,
    ownerToken,
    installMode = false,
    eyebrow = 'Browser analytics setup',
    title,
    purpose = 'analytics',
  } = props;
  const [state, setState] = useState<PublicKeysState>({ keys: [], created: null, error: null });
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const url = apiUrl('/v1/public-keys');
    url.searchParams.set('app_id', project.appId);
    loadOwnerJson(url, ownerToken)
      .then((body) => {
        if (cancelled) return;
        const keys = (body as ListPublicLogKeysResponseV1).keys.filter(
          (key) => key.environment_id === project.environmentId,
        );
        setState((previous) => ({ ...previous, keys, error: null }));
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        const error = cause instanceof Error ? cause.message : 'Could not load browser keys';
        setState((previous) => ({ ...previous, error }));
      });
    return () => {
      cancelled = true;
    };
  }, [ownerToken, project, refresh]);

  async function create(origins: string[]): Promise<void> {
    try {
      const response = await ownerFetch('/v1/public-keys', ownerToken, {
        method: 'POST',
        body: JSON.stringify({
          app_id: project.appId,
          environment_id: project.environmentId,
          allowed_origins: origins,
        }),
      });
      if (!response.ok) throw new Error(`API returned ${response.status}`);
      const created = (await response.json()) as CreatePublicLogKeyResponseV1;
      setState((previous) => ({ ...previous, created, error: null }));
      setRefresh((value) => value + 1);
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : 'Could not create browser key';
      setState((previous) => ({ ...previous, error }));
    }
  }

  async function revoke(keyId: string): Promise<void> {
    try {
      const response = await ownerFetch(`/v1/public-keys/${keyId}/revoke`, ownerToken, {
        method: 'POST',
      });
      if (!response.ok) throw new Error(`API returned ${response.status}`);
      setState((previous) => ({ ...previous, error: null }));
      setRefresh((value) => value + 1);
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : 'Could not revoke browser key';
      setState((previous) => ({ ...previous, error }));
    }
  }

  const content = (
    <div className="space-y-5">
      <p className="text-sm leading-6 text-muted-foreground">{BROWSER_KEY_COPY[purpose].intro}</p>
      <PublicKeyForm onCreate={create} />
      {state.error ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Browser key request failed</AlertTitle>
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.created ? (
        <PublicKeyReveal
          created={state.created}
          environment={project.environment}
          purpose={purpose}
        />
      ) : null}
      <PublicKeyList keys={state.keys} onRevoke={revoke} />
    </div>
  );
  if (installMode)
    return (
      <Card className="max-w-4xl shadow-none">
        <CardHeader className="border-b">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">
            {eyebrow}
          </p>
          <CardTitle className="text-xl">{title ?? `Connect ${project.name}`}</CardTitle>
          <p className="text-sm text-muted-foreground">
            Environment: {project.environment} · keys are restricted to the origins you enter.
          </p>
        </CardHeader>
        <CardContent className="pt-6">{content}</CardContent>
      </Card>
    );
  return (
    <Card className="shadow-none">
      <details>
        <summary className="flex min-h-14 cursor-pointer items-center px-6 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
          {BROWSER_KEY_COPY[purpose].summary} (
          {state.keys.filter((key) => key.revoked_at === null).length} active)
        </summary>
        <CardContent className="border-t pt-5">{content}</CardContent>
      </details>
    </Card>
  );
}

function PublicKeyForm({
  onCreate,
}: {
  onCreate: (origins: string[]) => Promise<void>;
}): JSX.Element {
  return (
    <form
      className="flex flex-col gap-3 sm:flex-row sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        const origins = parseOrigins(
          String(new FormData(event.currentTarget).get('origins') ?? ''),
        );
        if (origins.length > 0) void onCreate(origins);
      }}
    >
      <label className="grid flex-1 gap-2 text-sm font-medium">
        Allowed origins
        <Input
          name="origins"
          aria-label="Allowed origins"
          placeholder="https://example.com, http://localhost:5173"
          required
        />
      </label>
      <Button type="submit" variant="outline" className="h-10">
        Create browser key
      </Button>
    </form>
  );
}

function PublicKeyReveal({
  created,
  environment,
  purpose,
}: {
  created: CreatePublicLogKeyResponseV1;
  environment: string;
  purpose: BrowserKeyPurpose;
}): JSX.Element {
  const logsSnippet = `import { createWebLogger } from '@saas-maker/app-health/web';\n\nconst logs = createWebLogger({\n  publicKey: '${created.key}',\n  environment: ${JSON.stringify(environment)},\n  endpoint: '${INGEST_ORIGIN}/v1/logs',\n});\n\nlogs.log('pricing.viewed', { props: { plan: 'pro' } });`;
  const analyticsSnippet = `<script defer src="${location.origin}/tracker.js" data-key="${created.key}" data-endpoint="${INGEST_ORIGIN}/v1/browser"></script>\n\n<!-- After the tracker loads: window.appHealth.track('signup.completed') -->`;
  return (
    <div className="space-y-3 rounded-lg border border-primary/25 bg-primary/5 p-4">
      <strong className="block text-sm">Copy this key now; it is shown once.</strong>
      <code className="block break-all rounded-md bg-muted p-3 text-xs">{created.key}</code>
      {purpose !== 'logs' ? (
        <>
          <p className="text-sm font-medium">
            Page views, live sessions, and named analytics events
          </p>
          <pre className="overflow-x-auto rounded-md bg-zinc-950 p-4 text-xs leading-6 text-zinc-100">
            <code>{analyticsSnippet}</code>
          </pre>
        </>
      ) : null}
      {purpose !== 'analytics' ? (
        <>
          <p className="text-sm font-medium">
            {purpose === 'combined' ? 'Structured browser logs' : 'Send a browser log'}
          </p>
          <pre className="overflow-x-auto rounded-md bg-zinc-950 p-4 text-xs leading-6 text-zinc-100">
            <code>{logsSnippet}</code>
          </pre>
        </>
      ) : null}
    </div>
  );
}

function PublicKeyList({
  keys,
  onRevoke,
}: {
  keys: PublicLogKeyV1[];
  onRevoke: (keyId: string) => Promise<void>;
}): JSX.Element {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  async function confirmRevoke(keyId: string): Promise<void> {
    setPendingKey(keyId);
    await onRevoke(keyId);
    setPendingKey(null);
    setOpenKey(null);
  }
  if (keys.length === 0)
    return (
      <p className="text-xs text-muted-foreground">No browser keys for this environment yet.</p>
    );
  return (
    <ul className="space-y-2">
      {keys.map((key) => (
        <li key={key.id} className="flex items-center gap-4 rounded-md border p-3">
          <div className="min-w-0 flex-1">
            <code className="block truncate text-xs">{key.id}</code>
            <span className="block truncate text-xs text-muted-foreground">
              {key.allowed_origins.join(', ')}
            </span>
          </div>
          {key.revoked_at === null ? (
            <AlertDialog
              open={openKey === key.id}
              onOpenChange={(open) => setOpenKey(open ? key.id : null)}
            >
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-label={`Revoke browser key ${key.id}`}
                >
                  Revoke
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Revoke this browser key?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Browser analytics and logs from {key.allowed_origins.join(', ')} will stop until
                    that site receives another active key.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    disabled={pendingKey === key.id}
                    onClick={(event) => {
                      event.preventDefault();
                      void confirmRevoke(key.id);
                    }}
                  >
                    {pendingKey === key.id ? 'Revoking…' : 'Revoke key'}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : (
            <span className="text-xs text-muted-foreground">
              revoked {formatAge(key.revoked_at)}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

const CAPABILITY_COPY: Record<
  CapabilityId,
  { title: string; description: string; icon: typeof Activity }
> = {
  analytics: {
    title: 'Web analytics',
    description: 'Page views, live sessions, sources, and named product events.',
    icon: BarChart3,
  },
  endpoints: {
    title: 'Endpoint health',
    description: 'Request volume, error rate, and latency from your application routes.',
    icon: Activity,
  },
  logs: {
    title: 'Logs',
    description: 'Explicit browser and server events with the details your application provides.',
    icon: SlidersHorizontal,
  },
};

type CapabilityController = ReturnType<typeof useEnvironmentCapabilities>;

function CapabilityErrorNotice({
  message,
  onRetry,
  title = 'Capability status could not be updated',
}: {
  message: string;
  onRetry: () => void;
  title?: string;
}): JSX.Element {
  return (
    <Alert variant="destructive">
      <AlertTriangle />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="sm:flex-row sm:items-center sm:justify-between">
        <p>{message}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function CapabilityStatus({ state }: { state: EnvironmentCapabilities['capabilities'][number] }) {
  if (state.first_received_at !== null)
    return (
      <Badge variant="secondary" className="font-normal">
        Receiving data
      </Badge>
    );
  if (state.enabled)
    return (
      <Badge variant="outline" className="font-normal">
        Setup required
      </Badge>
    );
  return (
    <Badge variant="outline" className="font-normal text-muted-foreground">
      Hidden
    </Badge>
  );
}

function CapabilitySettings({
  controller,
  onOpen,
}: {
  controller: CapabilityController;
  onOpen: (id: CapabilityId) => void;
}): JSX.Element {
  if (controller.loading && !controller.data)
    return <Skeleton className="h-64 w-full" aria-label="Loading capabilities" />;
  if (!controller.data)
    return (
      <CapabilityErrorNotice
        title="Capability status is unavailable"
        message={controller.error || 'App Health could not load this environment.'}
        onRetry={controller.reload}
      />
    );
  const enabled = controller.data.capabilities
    .filter((item) => item.enabled)
    .map((item) => item.id);
  async function open(state: EnvironmentCapabilities['capabilities'][number]): Promise<void> {
    if (state.enabled) return onOpen(state.id);
    if (await controller.save([...enabled, state.id])) onOpen(state.id);
  }
  return (
    <Card className="shadow-none">
      <CardHeader className="border-b">
        <CardTitle className="text-base">Capabilities in this environment</CardTitle>
        <p className="text-sm leading-6 text-muted-foreground">
          Choose what appears in navigation. Incoming valid data remains accepted and activates its
          capability automatically.
        </p>
      </CardHeader>
      <CardContent className="space-y-4 pt-5">
        {controller.error ? (
          <CapabilityErrorNotice message={controller.error} onRetry={controller.reload} />
        ) : null}
        <div className="grid gap-3 lg:grid-cols-3">
          {controller.data.capabilities.map((state) => {
            const copy = CAPABILITY_COPY[state.id];
            const Icon = copy.icon;
            return (
              <Card key={state.id} className="shadow-none">
                <CardContent className="space-y-4 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <span className="flex size-9 items-center justify-center rounded-md bg-muted">
                      <Icon className="size-4 text-muted-foreground" />
                    </span>
                    <CapabilityStatus state={state} />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold">{copy.title}</h3>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {copy.description}
                    </p>
                  </div>
                  {state.last_received_at !== null ? (
                    <p className="text-xs text-muted-foreground">
                      Last valid data {formatAge(state.last_received_at)}
                    </p>
                  ) : null}
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={controller.saving}
                      onClick={() => void open(state)}
                    >
                      {state.first_received_at === null ? 'Open setup' : 'Open report'}
                    </Button>
                    <Button
                      size="sm"
                      variant={state.enabled ? 'secondary' : 'default'}
                      disabled={controller.saving}
                      aria-pressed={state.enabled}
                      onClick={() =>
                        void controller.save(
                          state.enabled
                            ? enabled.filter((id) => id !== state.id)
                            : [...enabled, state.id],
                        )
                      }
                    >
                      {state.enabled ? 'Hide' : 'Show'}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function OneTimeEnvironmentKey({ result }: { result: EnvironmentKeyResponse }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  async function copy(): Promise<void> {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(result.key.key);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
  }
  return (
    <div className="space-y-3">
      <Alert className="border-primary/25 bg-primary/5">
        <KeyRound />
        <AlertTitle>Save the private key for {result.environment.name}</AlertTitle>
        <AlertDescription className="space-y-3">
          <p>This environment-scoped key is shown once and stays only in memory on this page.</p>
          <code className="block break-all rounded-md bg-muted p-3 text-xs text-foreground">
            {result.key.key}
          </code>
          <Button size="sm" variant="outline" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy private key'}
          </Button>
        </AlertDescription>
      </Alert>
      {copyFailed ? <CopyFallback subject="key" /> : null}
    </div>
  );
}

function PrivateKeySummary({
  current,
}: {
  current: EnvironmentCapabilities['private_key'];
}): JSX.Element {
  if (!current)
    return <p className="text-sm text-muted-foreground">No active private key is available.</p>;
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <code className="block truncate text-xs">{current.id}</code>
        <p className="mt-1 text-xs text-muted-foreground">
          {current.environment_id === null
            ? 'Legacy project-wide key · preserved for compatibility'
            : `Environment key · created ${formatAge(current.created_at)}`}
        </p>
      </div>
      <Badge variant="secondary" className="w-fit font-normal">
        Active
      </Badge>
    </div>
  );
}

interface PrivateKeyActionProps {
  replacesEnvironmentKey: boolean;
  pending: boolean;
  confirming: boolean;
  error: string;
  scopeLabel: string;
  onConfirming: (open: boolean) => void;
  onIssue: () => Promise<boolean>;
}

function PrivateKeyAction(props: PrivateKeyActionProps): JSX.Element {
  const { replacesEnvironmentKey, pending, confirming, error, scopeLabel, onConfirming, onIssue } =
    props;
  const actionContainerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!confirming || !error || pending) return;
    const timeout = window.setTimeout(() => {
      actionContainerRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    });
    return () => window.clearTimeout(timeout);
  }, [confirming, error, pending]);
  async function replace(): Promise<void> {
    if (await onIssue()) onConfirming(false);
  }
  if (!replacesEnvironmentKey)
    return (
      <Button variant="outline" disabled={pending} onClick={() => void onIssue()}>
        {pending ? 'Creating…' : 'Create environment key'}
      </Button>
    );
  return (
    <AlertDialog open={confirming} onOpenChange={onConfirming}>
      <AlertDialogTrigger asChild>
        <Button ref={triggerRef} variant="outline">
          Replace environment key
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          triggerRef.current?.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Replace the key for {scopeLabel}?</AlertDialogTitle>
          <AlertDialogDescription>
            This replaces only the private key for {scopeLabel}. The current key will stop accepting
            writes, so update every server using it with the new one-time value.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {error ? (
            <Alert variant="destructive" className="mb-2 text-left sm:mr-auto">
              <AlertTriangle />
              <AlertTitle>Private key request failed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <div ref={actionContainerRef} className="contents">
            <AlertDialogAction
              disabled={pending}
              onClick={(event) => {
                event.preventDefault();
                void replace();
              }}
            >
              {pending ? 'Replacing…' : 'Replace key'}
            </AlertDialogAction>
          </div>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function PrivateKeyManager({
  project,
  ownerToken,
  controller,
}: {
  project: SavedProject;
  ownerToken: string;
  controller: CapabilityController;
}): JSX.Element {
  const [result, setResult] = useState<EnvironmentKeyResponse | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const current = controller.data?.private_key ?? null;
  const replacesEnvironmentKey = current?.environment_id === project.environmentId;
  async function issue(): Promise<boolean> {
    setPending(true);
    setError('');
    try {
      const response = await ownerFetch(
        `/v1/apps/${encodeURIComponent(project.appId)}/environments/${encodeURIComponent(project.environmentId)}/keys`,
        ownerToken,
        { method: 'POST' },
      );
      if (!response.ok) throw new Error(`API returned ${response.status}`);
      const parsed = EnvironmentKeyResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error('The key response was invalid');
      setResult(parsed.data);
      controller.reload();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not issue a private key');
      return false;
    } finally {
      setPending(false);
    }
  }
  return (
    <Card className="shadow-none">
      <CardHeader className="border-b">
        <CardTitle className="text-base">Private server key</CardTitle>
        <p className="text-sm text-muted-foreground">
          Write-only access for endpoint summaries and explicit server logs in {project.environment}
          .
        </p>
      </CardHeader>
      <CardContent className="space-y-4 pt-5">
        <PrivateKeySummary current={current} />
        {error && !replacesEnvironmentKey ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>Private key request failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {result ? <OneTimeEnvironmentKey result={result} /> : null}
        <PrivateKeyAction
          replacesEnvironmentKey={replacesEnvironmentKey}
          pending={pending}
          confirming={confirming}
          error={error}
          scopeLabel={`${project.name} / ${project.environment}`}
          onConfirming={setConfirming}
          onIssue={issue}
        />
      </CardContent>
    </Card>
  );
}

interface EnvironmentManagerProps {
  project: SavedProject;
  projects: SavedProject[];
  ownerToken: string;
  onCreated: (environment: SavedProject) => void;
}

function EnvironmentManager(props: EnvironmentManagerProps): JSX.Element {
  const { project, projects, ownerToken, onCreated } = props;
  const [name, setName] = useState('');
  const [result, setResult] = useState<EnvironmentKeyResponse | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const environments = projects.filter((candidate) => candidate.appId === project.appId);
  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError('');
    try {
      const response = await ownerFetch(
        `/v1/apps/${encodeURIComponent(project.appId)}/environments`,
        ownerToken,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name }),
        },
      );
      if (!response.ok) throw new Error(`API returned ${response.status}`);
      const parsed = EnvironmentKeyResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error('The environment response was invalid');
      setResult(parsed.data);
      setName('');
      onCreated({
        appId: project.appId,
        environmentId: parsed.data.environment.id,
        name: project.name,
        environment: parsed.data.environment.name,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not add the environment');
    } finally {
      setPending(false);
    }
  }
  return (
    <Card className="shadow-none">
      <CardHeader className="border-b">
        <CardTitle className="text-base">Environments</CardTitle>
        <p className="text-sm text-muted-foreground">
          Each environment keeps its own capabilities, reports, and write-only keys.
        </p>
      </CardHeader>
      <CardContent className="space-y-5 pt-5">
        <div className="flex flex-wrap gap-2">
          {environments.map((environment) => (
            <Badge
              key={environment.environmentId}
              variant={environment.environmentId === project.environmentId ? 'default' : 'outline'}
              className="font-normal"
            >
              {environment.environment}
            </Badge>
          ))}
        </div>
        <EnvironmentCreateForm name={name} pending={pending} onName={setName} onSubmit={submit} />
        {error ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>Environment could not be added</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {result ? <OneTimeEnvironmentKey result={result} /> : null}
      </CardContent>
    </Card>
  );
}

interface ProjectSettingsActions {
  onEnvironmentCreated: (environment: SavedProject) => void;
  onOpen: (id: CapabilityId) => void;
}

interface ProjectSettingsProps {
  project: SavedProject;
  projects: SavedProject[];
  ownerToken: string;
  controller: CapabilityController;
  actions: ProjectSettingsActions;
}

const ProjectSettings = (props: ProjectSettingsProps): JSX.Element => {
  const { project, projects, ownerToken, controller, actions } = props;
  return (
    <div className="space-y-5">
      <Alert>
        <Globe2 />
        <AlertTitle>
          Workspace / {project.name} / {project.environment}
        </AlertTitle>
        <AlertDescription>
          Settings on this page apply only to the selected environment.
        </AlertDescription>
      </Alert>
      <CapabilitySettings controller={controller} onOpen={actions.onOpen} />
      <div className="grid gap-5 xl:grid-cols-2">
        <EnvironmentManager
          project={project}
          projects={projects}
          ownerToken={ownerToken}
          onCreated={actions.onEnvironmentCreated}
        />
        <PrivateKeyManager project={project} ownerToken={ownerToken} controller={controller} />
      </div>
      <AnalyticsSharing
        key={`${project.appId}/${project.environmentId}`}
        project={project}
        ownerToken={ownerToken}
      />
      <NativeKeys
        key={`native/${project.appId}/${project.environmentId}/${ownerToken}`}
        project={project}
        ownerToken={ownerToken}
        ingestOrigin={INGEST_ORIGIN}
      />
      <PublicKeysPanel
        project={project}
        ownerToken={ownerToken}
        installMode={true}
        eyebrow="Public environment keys"
        title="Browser analytics and logs"
        purpose="combined"
      />
    </div>
  );
};

interface CapabilityBoundaryProps {
  id: CapabilityId;
  project: SavedProject;
  ownerToken: string;
  controller: CapabilityController;
  onManage: () => void;
  children: ReactNode;
}

function CapabilityBoundary(props: CapabilityBoundaryProps): JSX.Element {
  const { id, project, ownerToken, controller, onManage, children } = props;
  if (controller.loading && !controller.data)
    return <Skeleton className="h-64 w-full" aria-label="Loading capability status" />;
  if (!controller.data)
    return (
      <CapabilityErrorNotice
        title="Capability status is unavailable"
        message={controller.error || 'App Health could not load this environment.'}
        onRetry={controller.reload}
      />
    );
  const state = controller.data.capabilities.find((item) => item.id === id);
  if (!state)
    return (
      <CapabilityErrorNotice
        title="Capability status is incomplete"
        message="Refresh this environment before continuing."
        onRetry={controller.reload}
      />
    );
  if (!state.enabled)
    return (
      <div className="space-y-4">
        {controller.error ? (
          <CapabilityErrorNotice message={controller.error} onRetry={controller.reload} />
        ) : null}
        <Card className="shadow-none">
          <CardContent className="flex flex-col items-start gap-4 p-6">
            <Badge variant="outline">Hidden from navigation</Badge>
            <div>
              <h2 className="text-lg font-semibold">{CAPABILITY_COPY[id].title} is not selected</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Show it for {project.environment} to open setup or view previously received data.
                Disabling this preference never rejects incoming data.
              </p>
            </div>
            <Button
              disabled={controller.saving}
              onClick={() =>
                void controller.save([
                  ...controller
                    .data!.capabilities.filter((item) => item.enabled)
                    .map((item) => item.id),
                  id,
                ])
              }
            >
              Show {CAPABILITY_COPY[id].title}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  if (state.first_received_at === null)
    return (
      <div className="space-y-4">
        {controller.error ? (
          <CapabilityErrorNotice message={controller.error} onRetry={controller.reload} />
        ) : null}
        <CapabilitySetup
          id={id}
          project={project}
          ownerToken={ownerToken}
          privateKey={controller.data.private_key}
          onManage={onManage}
        />
      </div>
    );
  return (
    <div className="space-y-4">
      {controller.error ? (
        <CapabilityErrorNotice message={controller.error} onRetry={controller.reload} />
      ) : null}
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="secondary" className="font-normal">
          Connected
        </Badge>
        First valid data {formatAge(state.first_received_at)} · last valid data{' '}
        {state.last_received_at === null ? 'unknown' : formatAge(state.last_received_at)}
      </p>
      {children}
    </div>
  );
}

function ServerCapabilitySetup({
  id,
  project,
  privateKey,
  onManage,
}: {
  id: 'endpoints' | 'logs';
  project: SavedProject;
  privateKey: EnvironmentCapabilities['private_key'];
  onManage: () => void;
}): JSX.Element {
  const snippet =
    id === 'endpoints'
      ? `import { createAppHealthClient } from '@saas-maker/app-health';\nimport { honoMiddleware } from '@saas-maker/app-health/hono';\n\napp.use('*', honoMiddleware({\n  client: (c) => createAppHealthClient({\n    key: c.env.APP_HEALTH_INGEST_KEY,\n    environment: ${JSON.stringify(project.environment)},\n    endpoint: '${INGEST_ORIGIN}/v1/ingest',\n    runtime: 'worker',\n    disableTimer: true,\n  }),\n}));`
      : `import { createAppHealthClient } from '@saas-maker/app-health';\n\ninterface Env { APP_HEALTH_INGEST_KEY: string }\n\nexport default {\n  fetch(_request: Request, env: Env, ctx: ExecutionContext) {\n    const appHealth = createAppHealthClient({\n      key: env.APP_HEALTH_INGEST_KEY,\n      environment: ${JSON.stringify(project.environment)},\n      endpoint: '${INGEST_ORIGIN}/v1/ingest',\n      runtime: 'worker',\n      disableTimer: true,\n    });\n    appHealth.log('signup.completed', { title: 'New signup' });\n    ctx.waitUntil(appHealth.flush());\n    return new Response('ok');\n  },\n};`;
  return (
    <Card className="shadow-none">
      <CardHeader className="border-b">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">
          Cloudflare Worker · Hono
        </p>
        <CardTitle className="text-base">
          {id === 'endpoints' ? 'Connect endpoint health' : 'Send a server log'}
        </CardTitle>
        <p className="text-sm leading-6 text-muted-foreground">
          {privateKey
            ? `An active ${privateKey.environment_id === null ? 'legacy project' : 'environment'} key exists. Read its saved value from the APP_HEALTH_INGEST_KEY secret.`
            : 'Create a private environment key, save its one-time value as APP_HEALTH_INGEST_KEY, then add this integration.'}
        </p>
      </CardHeader>
      <CardContent className="space-y-4 pt-5">
        <pre className="overflow-x-auto rounded-md bg-zinc-950 p-4 text-xs leading-6 text-zinc-100">
          <code>{snippet}</code>
        </pre>
        <p className="text-xs leading-5 text-muted-foreground">
          Private keys stay in server secrets. The browser setup above uses a separate public,
          origin-bound key.
        </p>
        <Button variant="outline" onClick={onManage}>
          Manage private key
        </Button>
      </CardContent>
    </Card>
  );
}

function CapabilitySetup({
  id,
  project,
  ownerToken,
  privateKey,
  onManage,
}: {
  id: CapabilityId;
  project: SavedProject;
  ownerToken: string;
  privateKey: EnvironmentCapabilities['private_key'];
  onManage: () => void;
}): JSX.Element {
  const copy = CAPABILITY_COPY[id];
  return (
    <div className="space-y-5">
      <Alert>
        <Clock3 />
        <AlertTitle>Waiting for the first valid {copy.title.toLowerCase()} event</AlertTitle>
        <AlertDescription>
          Setup stays here until App Health accepts valid data for {project.name} /{' '}
          {project.environment}. Failed validation or delivery never marks it connected.
        </AlertDescription>
      </Alert>
      {id === 'analytics' || id === 'logs' ? (
        <PublicKeysPanel
          project={project}
          ownerToken={ownerToken}
          installMode
          eyebrow={id === 'analytics' ? 'Public browser key' : 'Browser log key'}
          title={id === 'analytics' ? 'Install web analytics' : 'Send browser logs'}
          purpose={id === 'logs' ? 'logs' : 'analytics'}
        />
      ) : null}
      {id === 'endpoints' || id === 'logs' ? (
        <ServerCapabilitySetup
          id={id}
          project={project}
          privateKey={privateKey}
          onManage={onManage}
        />
      ) : null}
    </div>
  );
}

const VIEW_HEADINGS: Record<DashboardView, [string, string, string]> = {
  analytics: [
    'Workspace',
    'Web analytics',
    'Active sessions now. Page views and manual events over the last 24 hours.',
  ],
  events: [
    'Product behavior',
    'Events',
    'See what people do, where it happens, and how activity changes over time.',
  ],
  endpoints: [
    'Observed routes',
    'Endpoint health',
    'Traffic, errors, and latency from requests your service actually handled.',
  ],
  data: [
    'Collection transparency',
    'Data received',
    'The exact telemetry App Health accepts and retains for this environment.',
  ],
  logs: [
    'Application events',
    'Logs',
    'Signups, waitlist joins, failed payments: whatever your app chose to send, by level.',
  ],
  install: [
    'Browser analytics',
    'Install web analytics',
    'Add page views, live sessions, and the named events your team chooses.',
  ],
  settings: [
    'Workspace configuration',
    'Project settings',
    'Manage this project’s environments, capabilities, and environment-scoped keys.',
  ],
  projects: [
    'Workspace overview',
    'Projects',
    'Product traffic and live sessions across your environments.',
  ],
};

interface DashboardHandlers {
  onProjectChange: (project: SavedProject) => void;
  onReset: () => void;
  onLock: () => void;
  accountSession: boolean;
  onEnvironmentCreated: (environment: SavedProject) => void;
}

const DASHBOARD_VIEWS: DashboardView[] = [
  'analytics',
  'events',
  'projects',
  'endpoints',
  'data',
  'logs',
  'install',
  'settings',
];

function viewFromHash(): DashboardView {
  const saved = location.hash.slice(1);
  return DASHBOARD_VIEWS.includes(saved as DashboardView) ? (saved as DashboardView) : 'analytics';
}

function useEndpointData(
  project: SavedProject,
  ownerToken: string,
  windowKey: Window,
  enabled: boolean,
) {
  const [data, setData] = useState<EndpointQueryResponseV1 | null>(null);
  const [status, setStatus] = useState<InstallationStatusV1 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let inFlight = false;
    let activeController: AbortController | null = null;
    let activeTimeout: number | undefined;

    setData(null);
    setStatus(null);
    setError(null);
    setLoading(true);

    async function load(): Promise<void> {
      if (inFlight) return;
      inFlight = true;
      const controller = new AbortController();
      activeController = controller;
      activeTimeout = window.setTimeout(() => controller.abort(), 8_000);
      try {
        const endpointsUrl = apiUrl('/v1/endpoints');
        endpointsUrl.searchParams.set('app_id', project.appId);
        endpointsUrl.searchParams.set('environment_id', project.environmentId);
        endpointsUrl.searchParams.set('window', windowKey);
        const statusUrl = apiUrl('/v1/installation/status');
        statusUrl.searchParams.set('app_id', project.appId);
        statusUrl.searchParams.set('environment_id', project.environmentId);
        const [endpointResponse, statusResponse] = await Promise.all([
          ownerFetch(endpointsUrl, ownerToken, { signal: controller.signal }),
          ownerFetch(statusUrl, ownerToken, { signal: controller.signal }),
        ]);
        if (!endpointResponse.ok || !statusResponse.ok)
          throw new Error(
            `API returned ${!endpointResponse.ok ? endpointResponse.status : statusResponse.status}`,
          );
        const nextData = readDashboardResponse(
          await endpointResponse.json(),
          EndpointQueryResponseV1Schema,
          'endpoint data',
        );
        const nextStatus = readDashboardResponse(
          await statusResponse.json(),
          InstallationStatusV1Schema,
          'installation status',
        );
        if (!cancelled && !controller.signal.aborted) {
          setData(nextData);
          setStatus(nextStatus);
          setError(null);
        }
      } catch (cause) {
        if (!cancelled)
          setError(
            cause instanceof DOMException && cause.name === 'AbortError'
              ? 'Endpoint data request timed out'
              : cause instanceof Error
                ? cause.message
                : 'Unknown API error',
          );
      } finally {
        window.clearTimeout(activeTimeout);
        activeController = null;
        inFlight = false;
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    const stopPolling = pollWhileVisible(() => void load(), 10_000);
    return () => {
      cancelled = true;
      activeController?.abort();
      window.clearTimeout(activeTimeout);
      stopPolling();
    };
  }, [ownerToken, project.appId, project.environmentId, windowKey, enabled]);

  return { data, status, error, loading };
}

function useDashboardNavigation(): [DashboardView, (value: DashboardView) => void] {
  const [view, setView] = useState<DashboardView>(viewFromHash);
  useEffect(() => {
    document.title = `${VIEW_HEADINGS[view][1]} — App Health`;
  }, [view]);
  useEffect(() => {
    const syncView = () => setView(viewFromHash());
    window.addEventListener('hashchange', syncView);
    window.addEventListener('popstate', syncView);
    return () => {
      window.removeEventListener('hashchange', syncView);
      window.removeEventListener('popstate', syncView);
    };
  }, []);
  return [
    view,
    (value) => {
      setView(value);
      if (location.hash !== `#${value}`) history.pushState(null, '', `#${value}`);
    },
  ];
}

interface EndpointPanelProps {
  project: SavedProject;
  ownerToken: string;
  controller: ReturnType<typeof useEnvironmentCapabilities>;
  windowKey: Window;
  onWindowChange: (value: Window) => void;
  status: InstallationStatusV1 | null;
  error: string | null;
  loading: boolean;
  endpoints: EndpointAggregateV1[];
  sortKey: SortKey;
  sortDirection: SortDirection;
  onSort: (key: SortKey) => void;
  onManage: () => void;
}

function EndpointPanel(props: EndpointPanelProps): JSX.Element {
  const {
    project,
    ownerToken,
    controller,
    windowKey,
    onWindowChange,
    status,
    error,
    loading,
    endpoints,
    sortKey,
    sortDirection,
    onSort,
    onManage,
  } = props;
  return (
    <CapabilityBoundary
      id="endpoints"
      project={project}
      ownerToken={ownerToken}
      controller={controller}
      onManage={onManage}
    >
      <div className="space-y-5">
        <TimeWindowControl value={windowKey} onChange={onWindowChange} />
        <EndpointHealth
          project={project}
          status={status}
          error={error}
          loading={loading}
          endpoints={endpoints}
          sortKey={sortKey}
          sortDirection={sortDirection}
          onSort={onSort}
        />
      </div>
    </CapabilityBoundary>
  );
}

interface DashboardContentProps {
  view: DashboardView;
  project: SavedProject;
  projects: SavedProject[];
  ownerToken: string;
  handlers: DashboardHandlers;
  capabilities: ReturnType<typeof useEnvironmentCapabilities>;
  windowKey: Window;
  setWindowKey: (value: Window) => void;
  status: InstallationStatusV1 | null;
  error: string | null;
  loading: boolean;
  endpoints: EndpointAggregateV1[];
  sortKey: SortKey;
  sortDirection: SortDirection;
  onSort: (key: SortKey) => void;
  onManage: () => void;
  onView: (value: DashboardView) => void;
}

function DashboardContent(props: DashboardContentProps): JSX.Element {
  const { view, project, ownerToken, capabilities } = props;
  if (view === 'endpoints')
    return (
      <EndpointPanel
        project={project}
        ownerToken={ownerToken}
        controller={capabilities}
        windowKey={props.windowKey}
        onWindowChange={props.setWindowKey}
        status={props.status}
        error={props.error}
        loading={props.loading}
        endpoints={props.endpoints}
        sortKey={props.sortKey}
        sortDirection={props.sortDirection}
        onSort={props.onSort}
        onManage={props.onManage}
      />
    );
  if (view === 'data')
    return (
      <CapabilityBoundary
        id="endpoints"
        project={project}
        ownerToken={ownerToken}
        controller={capabilities}
        onManage={props.onManage}
      >
        <div className="space-y-5">
          <TimeWindowControl value={props.windowKey} onChange={props.setWindowKey} />
          <DataReceived project={project} ownerToken={ownerToken} windowKey={props.windowKey} />
        </div>
      </CapabilityBoundary>
    );
  return view === 'analytics' || view === 'events' ? (
    <DashboardAnalytics {...props} />
  ) : (
    <DashboardManagement {...props} />
  );
}

function DashboardAnalytics(props: DashboardContentProps): JSX.Element {
  const { view, project, projects, ownerToken, handlers, capabilities } = props;
  return (
    <CapabilityBoundary
      id="analytics"
      project={project}
      ownerToken={ownerToken}
      controller={capabilities}
      onManage={props.onManage}
    >
      <AnalyticsView
        key={view}
        mode={view === 'events' ? 'events' : 'web'}
        onInstall={() => props.onView('install')}
        project={project}
        projects={projects}
        ownerToken={ownerToken}
        onSelect={(selected) => {
          props.onView('analytics');
          handlers.onProjectChange(selected);
        }}
      />
    </CapabilityBoundary>
  );
}

function DashboardManagement(props: DashboardContentProps): JSX.Element {
  const { view, project, projects, ownerToken, handlers, capabilities } = props;
  if (view === 'projects')
    return (
      <ProjectsView
        projects={projects}
        ownerToken={ownerToken}
        onOpen={(selected) => {
          handlers.onProjectChange(selected);
          props.onView('analytics');
        }}
      />
    );
  if (view === 'install')
    return <PublicKeysPanel project={project} ownerToken={ownerToken} installMode />;
  if (view === 'logs')
    return (
      <CapabilityBoundary
        id="logs"
        project={project}
        ownerToken={ownerToken}
        controller={capabilities}
        onManage={props.onManage}
      >
        <LogsView project={project} ownerToken={ownerToken} />
      </CapabilityBoundary>
    );
  return (
    <ProjectSettings
      project={project}
      projects={projects}
      ownerToken={ownerToken}
      controller={capabilities}
      actions={{ onEnvironmentCreated: handlers.onEnvironmentCreated, onOpen: props.onView }}
    />
  );
}

function Dashboard({
  project,
  projects,
  ownerToken,
  handlers,
}: {
  project: SavedProject;
  projects: SavedProject[];
  ownerToken: string;
  handlers: DashboardHandlers;
}): JSX.Element {
  const [view, changeView] = useDashboardNavigation();
  const [windowKey, setWindowKey] = useState<Window>('15m');
  const [sortKey, setSortKey] = useState<SortKey>('health');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const capabilities = useEnvironmentCapabilities(project, ownerToken);
  const { data, status, error, loading } = useEndpointData(
    project,
    ownerToken,
    windowKey,
    view === 'endpoints',
  );

  const sorted = useMemo(
    () => sortEndpoints(data?.endpoints ?? [], sortKey, sortDirection),
    [data, sortKey, sortDirection],
  );

  function changeSort(next: SortKey): void {
    if (next === sortKey) setSortDirection((value) => (value === 'desc' ? 'asc' : 'desc'));
    else {
      setSortKey(next);
      setSortDirection('desc');
    }
  }

  return (
    <ProductShell
      view={view}
      title={VIEW_HEADINGS[view][1]}
      description={VIEW_HEADINGS[view][2]}
      project={project}
      projects={projects}
      onView={changeView}
      onProject={handlers.onProjectChange}
      onAdd={handlers.onReset}
      onLock={handlers.onLock}
      accountSession={handlers.accountSession}
      enabledCapabilities={capabilities.data?.capabilities
        .filter((item) => item.enabled)
        .map((item) => item.id)}
    >
      <DashboardContent
        view={view}
        project={project}
        projects={projects}
        ownerToken={ownerToken}
        handlers={handlers}
        capabilities={capabilities}
        windowKey={windowKey}
        setWindowKey={setWindowKey}
        status={status}
        error={error}
        loading={loading}
        endpoints={sorted}
        sortKey={sortKey}
        sortDirection={sortDirection}
        onSort={changeSort}
        onManage={() => changeView('settings')}
        onView={changeView}
      />
    </ProductShell>
  );
}

function initialProject(): SavedProject | null {
  if (
    import.meta.env.DEV &&
    new URLSearchParams(window.location.search).get('demo') === 'populated'
  )
    return {
      appId: SEED_APP_ID,
      environmentId: SEED_ENV_ID,
      name: SEED_APP_NAME,
      environment: SEED_ENV_NAME,
    };
  return requestedProjectFromLocation() ? null : readProject();
}

interface ProjectSetupShellProps {
  projects: SavedProject[];
  accountSession: boolean;
  sessionError: string;
  selectionError: string;
  ownerToken: string;
  selectProject: (project: SavedProject) => void;
  lock: () => Promise<void>;
  handleCreated: (created: CreateAppResponseV1) => void;
}
function ProjectSetupShell(props: ProjectSetupShellProps): JSX.Element {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-2 px-4 sm:px-6">
          <ProductBrand />
          <nav className="ml-auto flex items-center gap-2" aria-label="Workspace">
            {props.projects.length > 0 ? (
              <Button variant="outline" onClick={() => props.selectProject(props.projects[0])}>
                Back to projects
              </Button>
            ) : null}
            {props.accountSession ? (
              <Button variant="ghost" onClick={() => void props.lock()}>
                Sign out
              </Button>
            ) : null}
            <ThemeToggle />
          </nav>
        </div>
      </header>
      {props.sessionError ? (
        <Alert variant="destructive" className="mx-auto mt-4 max-w-6xl">
          <AlertTriangle />
          <AlertTitle>Account action failed</AlertTitle>
          <AlertDescription>{props.sessionError}</AlertDescription>
        </Alert>
      ) : null}
      {props.selectionError ? (
        <Alert variant="destructive" className="mx-auto mt-4 max-w-6xl">
          <AlertTriangle />
          <AlertTitle>Project unavailable</AlertTitle>
          <AlertDescription>{props.selectionError}</AlertDescription>
        </Alert>
      ) : null}
      <Setup ownerToken={props.ownerToken} onCreated={props.handleCreated} />
    </div>
  );
}

async function requestSignOut(): Promise<void> {
  const response = await fetch('/v1/auth/sign-out', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) throw new Error('Could not sign out. Please try again.');
}

export function App(): JSX.Element {
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [accountSession, setAccountSession] = useState(false);
  const [sessionError, setSessionError] = useState('');
  const [ownerToken, setOwnerToken] = useState<string | null>(() =>
    import.meta.env.DEV ? '' : null,
  );
  const [project, setProject] = useState<SavedProject | null>(initialProject);
  const [requestedProject, setRequestedProject] = useState(requestedProjectFromLocation);
  const [strictRequestedProject, setStrictRequestedProject] = useState(
    () => requestedProjectFromLocation() !== null,
  );
  const [selectionError, setSelectionError] = useState('');
  const [inventoryError, setInventoryError] = useState('');
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [inventoryRetry, setInventoryRetry] = useState(0);
  const [created, setCreated] = useState<CreateAppResponseV1 | null>(null);
  const [projects, setProjects] = useState<SavedProject[]>([]);

  useEffect(() => {
    if (ownerToken === null) return;
    const token = ownerToken;
    let cancelled = false;
    setInventoryLoading(strictRequestedProject);
    setInventoryError('');
    async function load(): Promise<void> {
      try {
        const response = await ownerFetch('/v1/apps', token);
        if (!response.ok) throw new Error(`Workspace returned ${response.status}`);
        const listed = (await response.json()) as ListAppsResponseV1;
        const available = availableProjects(listed);
        if (cancelled) return;
        setProjects(available);
        if (!strictRequestedProject && !project) {
          setInventoryLoading(false);
          return;
        }
        const resolution = resolveInventorySelection(
          project,
          requestedProject,
          strictRequestedProject,
          available,
        );
        if (resolution.unavailableTarget && requestedProject) {
          setProject(null);
          setSelectionError(projectUnavailableMessage(requestedProject));
          setInventoryLoading(false);
          return;
        }
        setSelectionError('');
        setInventoryLoading(false);
        const selected = resolution.selected;
        if (
          selected &&
          (!project ||
            selected.appId !== project.appId ||
            selected.environmentId !== project.environmentId)
        ) {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(selected));
          setProject(selected);
          setCreated(null);
        }
      } catch {
        if (!cancelled && strictRequestedProject) {
          setProject(null);
          setInventoryError('The workspace project list could not load. Try again.');
          setInventoryLoading(false);
        }
      }
    }
    void load();
    const stopPolling = pollWhileVisible(() => void load(), 10_000);
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [
    ownerToken,
    project?.appId,
    project?.environmentId,
    requestedProject,
    strictRequestedProject,
    inventoryRetry,
  ]);

  useEffect(() => {
    function syncLocation(): void {
      const next = requestedProjectFromLocation();
      setRequestedProject(next);
      setStrictRequestedProject(next !== null);
      if (next) {
        const selected = projects.find(
          (candidate) =>
            candidate.appId === next.appId && candidate.environmentId === next.environmentId,
        );
        if (selected) {
          setSelectionError('');
          setProject(selected);
        } else if (projects.length > 0) {
          setProject(null);
          setSelectionError(projectUnavailableMessage(next));
        }
      } else if (projects.length > 0) {
        setSelectionError('');
        setProject(authorizedProject(readProject(), projects));
      }
    }
    window.addEventListener('popstate', syncLocation);
    return () => window.removeEventListener('popstate', syncLocation);
  }, [projects]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const config = await fetch('/v1/account/config');
      if (!config.ok) return;
      const options = (await config.json()) as { google?: boolean };
      if (!options.google || cancelled) return;
      setGoogleEnabled(true);
      const response = await fetch('/v1/apps');
      if (!response.ok) return;
      const listed = (await response.json()) as ListAppsResponseV1;
      if (cancelled) return;
      handleUnlock('', listed);
      setAccountSession(true);
    })().catch(() => {
      /* Legacy deployments continue to offer their existing unlock. */
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function selectProject(value: SavedProject): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    setProject(value);
    setRequestedProject({ appId: value.appId, environmentId: value.environmentId });
    setStrictRequestedProject(false);
    setSelectionError('');
    const url = new URL(window.location.href);
    url.pathname = '/app';
    url.search = new URLSearchParams({
      project: value.appId,
      environment: value.environmentId,
    }).toString();
    if (!url.hash) url.hash = '#analytics';
    history.pushState(null, '', `${url.pathname}${url.search}${url.hash}`);
    setCreated(null);
  }

  function handleCreated(value: CreateAppResponseV1): void {
    const saved = {
      appId: value.app.id,
      environmentId: value.environment.id,
      name: value.app.name,
      environment: value.environment.name,
    };
    setProjects((available) => [
      ...available.filter((candidate) => candidate.environmentId !== saved.environmentId),
      saved,
    ]);
    selectProject(saved);
    setCreated(value);
  }

  function handleEnvironmentCreated(value: SavedProject): void {
    setProjects((available) => [
      ...available.filter((candidate) => candidate.environmentId !== value.environmentId),
      value,
    ]);
  }

  function handleUnlock(token: string, listed: ListAppsResponseV1): void {
    const available = availableProjects(listed);
    const selected =
      strictRequestedProject && requestedProject
        ? (available.find(
            (candidate) =>
              candidate.appId === requestedProject.appId &&
              candidate.environmentId === requestedProject.environmentId,
          ) ?? null)
        : authorizedProject(project, available);
    setProjects(available);
    if (selected) selectProject(selected);
    else if (strictRequestedProject && requestedProject) {
      setProject(null);
      setSelectionError(projectUnavailableMessage(requestedProject));
    } else reset();
    setOwnerToken(token);
  }

  function reset(): void {
    localStorage.removeItem(STORAGE_KEY);
    setCreated(null);
    setProject(null);
    setRequestedProject(null);
    setStrictRequestedProject(false);
    setSelectionError('');
    const url = new URL(window.location.href);
    url.pathname = '/app';
    url.search = '';
    history.pushState(null, '', `${url.pathname}${url.hash}`);
  }

  async function lock(): Promise<void> {
    setSessionError('');
    if (accountSession) {
      try {
        await requestSignOut();
        setAccountSession(false);
        reset();
      } catch {
        setSessionError('Could not sign out. Please try again.');
        return;
      }
    }
    if (accountSession || !import.meta.env.DEV) setOwnerToken(null);
    setProjects([]);
    setCreated(null);
  }

  if (ownerToken === null)
    return <OwnerUnlock onUnlock={handleUnlock} googleEnabled={googleEnabled} />;
  if (created)
    return (
      <KeySetup
        created={created}
        onDone={() => {
          history.replaceState(null, '', '#settings');
          setCreated(null);
        }}
      />
    );
  if (strictRequestedProject && inventoryLoading)
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        Loading workspace project…
      </div>
    );
  if (strictRequestedProject && inventoryError)
    return (
      <div className="mx-auto flex min-h-screen max-w-2xl items-center px-4">
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Project link unavailable</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>{inventoryError}</p>
            <Button variant="outline" onClick={() => setInventoryRetry((value) => value + 1)}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  if (!project)
    return (
      <ProjectSetupShell
        projects={projects}
        accountSession={accountSession}
        sessionError={sessionError}
        selectionError={selectionError}
        ownerToken={ownerToken}
        selectProject={selectProject}
        lock={lock}
        handleCreated={handleCreated}
      />
    );

  return (
    <>
      {sessionError ? (
        <Alert variant="destructive" className="fixed right-4 top-4 z-50 max-w-sm shadow-lg">
          <AlertTriangle />
          <AlertTitle>Account action failed</AlertTitle>
          <AlertDescription>{sessionError}</AlertDescription>
        </Alert>
      ) : null}
      <Dashboard
        key={`${project.appId}/${project.environmentId}`}
        project={project}
        projects={
          projects.some((candidate) => candidate.environmentId === project.environmentId)
            ? projects
            : [project, ...projects]
        }
        ownerToken={ownerToken}
        handlers={{
          onProjectChange: selectProject,
          onReset: reset,
          onLock: () => void lock(),
          accountSession,
          onEnvironmentCreated: handleEnvironmentCreated,
        }}
      />
    </>
  );
}
