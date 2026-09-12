import { useState } from 'react';
import { Activity, ArrowUpRight, Check, Copy, RefreshCw } from 'lucide-react';
import { Badge } from './components/ui/badge.js';
import { Button } from './components/ui/button.js';
import { Card, CardContent, CardHeader } from './components/ui/card.js';
import { productAnalyticsHref } from './lib/product-links.js';
import { useWorkspaceAnalytics } from './useAnalytics.js';

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

const number = (value: number) => value.toLocaleString();

function activeSessions(
  workspace: ReturnType<typeof useWorkspaceAnalytics>,
  project: ProjectsViewProject,
): number | null {
  if (workspace.data?.source !== 'local' && !workspace.connected) return null;
  return (
    workspace.live?.projects.find(
      (row) => row.app_id === project.appId && row.environment_id === project.environmentId,
    )?.active ?? 0
  );
}

function DashboardLink({ href }: { href: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const absoluteHref = `${window.location.origin}${href}`;

  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(absoluteHref);
      setState('copied');
    } catch {
      setState('failed');
    }
  }

  return (
    <div className="flex min-w-0 flex-col items-stretch gap-2 sm:flex-row sm:items-center">
      <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
        {state === 'copied' ? <Check /> : <Copy />}
        {state === 'copied' ? 'Copied' : 'Copy dashboard link'}
      </Button>
      {state === 'failed' ? (
        <input
          aria-label="Dashboard link fallback"
          className="h-8 min-w-0 rounded-md border bg-background px-2 font-mono text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={absoluteHref}
          readOnly
          onFocus={(event) => event.currentTarget.select()}
        />
      ) : null}
      <span className="sr-only" aria-live="polite">
        {state === 'copied' ? 'Dashboard link copied.' : ''}
        {state === 'failed' ? 'Copy failed. Select the dashboard link to copy it manually.' : ''}
      </span>
    </div>
  );
}

function ProjectCard({
  project,
  workspace,
  onOpen,
}: {
  project: ProjectsViewProject;
  workspace: ReturnType<typeof useWorkspaceAnalytics>;
  onOpen: (project: ProjectsViewProject) => void;
}) {
  const href = productAnalyticsHref({
    appId: project.appId,
    environmentId: project.environmentId,
  });
  const summary = workspace.data?.projects.find(
    (row) => row.app_id === project.appId && row.environment_id === project.environmentId,
  );
  const active = activeSessions(workspace, project);

  return (
    <Card className="min-w-0 shadow-none transition-colors hover:border-primary/40">
      <CardHeader className="gap-3 border-b pb-5">
        <div className="flex min-w-0 items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold tracking-tight">{project.name}</h3>
            <Badge variant="secondary" className="mt-2 font-mono font-normal">
              {project.environment}
            </Badge>
          </div>
          <Activity className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </div>
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-11 items-center justify-between gap-2 rounded-md text-sm font-medium text-primary underline-offset-4 hover:underline"
          onClick={(event) => {
            if (
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            event.preventDefault();
            onOpen(project);
          }}
        >
          Open analytics <ArrowUpRight className="size-4" />
        </a>
      </CardHeader>
      <CardContent className="grid grid-cols-3 gap-3 pt-5">
        <Metric label="Browser sessions" value={active === null ? '—' : number(active)} live />
        <Metric label="Views · 24h" value={summary ? number(summary.pageviews) : '—'} />
        <Metric label="Events · 24h" value={summary ? number(summary.events) : '—'} />
      </CardContent>
      <div className="px-6 pb-6 pt-1">
        <DashboardLink href={href} />
      </div>
    </Card>
  );
}

function Metric({ label, value, live = false }: { label: string; value: string; live?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-lg font-semibold tabular-nums tracking-tight">
        {live ? <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden="true" /> : null}
        {value}
      </div>
      <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{label}</p>
    </div>
  );
}

export function ProjectsView({ projects, ownerToken, onOpen }: ProjectsViewProps): JSX.Element {
  const workspace = useWorkspaceAnalytics(ownerToken);
  const grouped = projects.reduce<Map<string, ProjectsViewProject[]>>((groups, project) => {
    const existing = groups.get(project.appId) ?? [];
    existing.push(project);
    groups.set(project.appId, existing);
    return groups;
  }, new Map());

  if (projects.length === 0) {
    return (
      <section aria-labelledby="projects-title" className="mx-auto w-full max-w-6xl">
        <Card className="shadow-none">
          <CardContent className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
            <h2 id="projects-title" className="text-lg font-semibold tracking-tight">
              No projects yet
            </h2>
            <p className="max-w-md text-sm text-muted-foreground">
              Add an environment to start receiving browser sessions, views, and events.
            </p>
          </CardContent>
        </Card>
      </section>
    );
  }

  return (
    <section aria-labelledby="projects-title" className="mx-auto w-full max-w-6xl space-y-8">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
            Workspace
          </p>
          <h2 id="projects-title" className="mt-2 text-2xl font-semibold tracking-tight">
            Projects
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Product traffic and live sessions across your environments.
          </p>
        </div>
        {workspace.error ? (
          <Button type="button" variant="outline" onClick={workspace.reload}>
            <RefreshCw /> Try again
          </Button>
        ) : null}
      </div>
      {workspace.error ? (
        <Card role="alert" className="border-destructive/40 bg-destructive/5 shadow-none">
          <CardContent className="p-4 text-sm">
            <p className="font-medium">Analytics could not refresh</p>
            <p className="mt-1 text-xs text-muted-foreground">{workspace.error}</p>
          </CardContent>
        </Card>
      ) : null}
      {!workspace.data && !workspace.error ? (
        <div
          role="status"
          aria-label="Loading analytics"
          className="rounded-xl border p-6 text-sm text-muted-foreground"
        >
          Loading analytics…
        </div>
      ) : null}
      {[...grouped.entries()].map(([appId, environments]) => (
        <div key={appId} className="space-y-3">
          <h3 className="text-sm font-medium text-muted-foreground">{environments[0].name}</h3>
          <div className="grid gap-4 md:grid-cols-2">
            {environments.map((project) => (
              <ProjectCard
                key={`${project.appId}:${project.environmentId}`}
                project={project}
                workspace={workspace}
                onOpen={onOpen}
              />
            ))}
          </div>
        </div>
      ))}
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Activity className="size-3" /> Live counts describe sessions observed in the last 45
        seconds.
      </p>
    </section>
  );
}
