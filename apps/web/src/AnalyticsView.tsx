import { useState } from 'react';
import { Activity, ArrowRight, RefreshCw, X } from 'lucide-react';
import { AnalyticsReport, type AnalyticsReportProps } from './AnalyticsReport.js';
import { useBrowserReport, useWorkspaceAnalytics } from './useAnalytics.js';
import { Badge } from './components/ui/badge.js';
import { Button } from './components/ui/button.js';
import { Card, CardContent, CardHeader } from './components/ui/card.js';
import { LabeledSelect as ReportSelect } from './LabeledSelect.js';
import { Skeleton } from './components/ui/skeleton.js';

interface Project {
  appId: string;
  environmentId: string;
  name: string;
  environment: string;
}

const count = (value: number) => value.toLocaleString();

function ReportLoading() {
  return (
    <div role="status" aria-label="Loading analytics" className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {[1, 2, 3].map((key) => (
          <Skeleton key={key} className="h-32" />
        ))}
      </div>
      <Skeleton className="h-80" />
    </div>
  );
}

function ReportError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card role="alert" className="border-destructive/40 bg-destructive/5 shadow-none">
      <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Analytics could not refresh</p>
          <p className="mt-1 text-xs text-muted-foreground">{message}</p>
        </div>
        <Button variant="outline" onClick={onRetry}>
          <RefreshCw /> Try again
        </Button>
      </CardContent>
    </Card>
  );
}

function ProjectRows({
  projects,
  summary,
  onSelect,
}: {
  projects: Project[];
  summary: ReturnType<typeof useWorkspaceAnalytics>['data'];
  onSelect: (project: Project) => void;
}) {
  return (
    <Card className="shadow-none">
      <CardHeader className="flex flex-row items-center justify-between border-b pb-4">
        <h2 className="text-sm font-semibold">Your projects</h2>
        <span className="text-xs text-muted-foreground">Open app health</span>
      </CardHeader>
      <CardContent className="p-0">
        {projects.map((project) => {
          const row = summary?.projects.find(
            (item) =>
              item.app_id === project.appId && item.environment_id === project.environmentId,
          );
          return (
            <button
              key={project.environmentId}
              className="grid min-h-16 w-full grid-cols-[1fr_auto] items-center gap-4 border-b px-5 text-left last:border-0 hover:bg-muted/50 sm:grid-cols-[1fr_8rem_8rem_auto]"
              onClick={() => onSelect(project)}
            >
              <span className="min-w-0">
                <strong className="block truncate text-sm font-medium">{project.name}</strong>
                <small className="text-xs text-muted-foreground">{project.environment}</small>
              </span>
              <span className="hidden text-right text-sm tabular-nums sm:block">
                {row ? count(row.pageviews) : '—'}{' '}
                <small className="block text-xs text-muted-foreground">views · 24h</small>
              </span>
              <span className="hidden text-right text-sm tabular-nums sm:block">
                {row ? count(row.events) : '—'}{' '}
                <small className="block text-xs text-muted-foreground">events · 24h</small>
              </span>
              <ArrowRight className="size-4 text-muted-foreground" />
            </button>
          );
        })}
      </CardContent>
    </Card>
  );
}

interface AnalyticsViewProps {
  projects: Project[];
  project: Project;
  ownerToken: string;
  onSelect: (project: Project) => void;
  mode?: 'web' | 'events';
  onInstall?: () => void;
}

interface ReportFiltersProps {
  apps: Project[];
  environments: Project[];
  appId: string;
  environmentId: string;
  range: string;
  selected: string;
  onApp: (value: string) => void;
  onEnvironment: (value: string) => void;
  onRange: (value: string) => void;
  onClearEvent: () => void;
  onInstall?: () => void;
}

function ReportFilters(props: ReportFiltersProps): JSX.Element {
  const {
    apps,
    environments,
    appId,
    environmentId,
    range,
    selected,
    onApp,
    onEnvironment,
    onRange,
    onClearEvent,
    onInstall,
  } = props;
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-3 lg:flex-row lg:items-center">
      <div className="flex flex-1 flex-col gap-2 sm:flex-row">
        <ReportSelect
          label="Analytics project"
          value={appId}
          onValueChange={onApp}
          triggerClassName="h-10 min-w-40"
          options={[
            { value: 'all', label: 'All projects' },
            ...apps.map((item) => ({ value: item.appId, label: item.name })),
          ]}
        />
        {appId !== 'all' ? (
          <ReportSelect
            label="Analytics environment"
            value={environmentId}
            onValueChange={onEnvironment}
            triggerClassName="h-10 min-w-40"
            options={environments.map((item) => ({
              value: item.environmentId,
              label: item.environment,
            }))}
          />
        ) : null}
        <ReportSelect
          label="Analytics period"
          value={range}
          onValueChange={onRange}
          triggerClassName="h-10 min-w-40"
          options={[
            { value: '24h', label: 'Last 24 hours' },
            { value: '1h', label: 'Last hour' },
          ]}
        />
      </div>
      {selected ? (
        <Badge variant="secondary" className="h-10 max-w-full gap-2 px-3 font-mono font-normal">
          <span className="truncate">{selected}</span>
          <button aria-label="Clear event filter" onClick={onClearEvent}>
            <X className="size-3.5" />
          </button>
        </Badge>
      ) : null}
      <Button variant="outline" className="h-10 w-full lg:w-auto" onClick={onInstall}>
        Install tracker <ArrowRight />
      </Button>
    </div>
  );
}

function activeSessionCount(
  workspace: ReturnType<typeof useWorkspaceAnalytics>,
  appId: string,
  environmentId: string,
): number | null {
  if (workspace.data?.source !== 'local' && !workspace.connected) return null;
  return (
    workspace.live?.projects
      .filter(
        (row) =>
          appId === 'all' ||
          (row.app_id === appId && (!environmentId || row.environment_id === environmentId)),
      )
      .reduce((sum, row) => sum + row.active, 0) ?? 0
  );
}

type AnalyticsResultsProps = Omit<AnalyticsReportProps, 'report'> & {
  workspace: ReturnType<typeof useWorkspaceAnalytics>;
  detail: ReturnType<typeof useBrowserReport>;
};

function AnalyticsResults(props: AnalyticsResultsProps): JSX.Element {
  const { workspace, detail } = props;
  return (
    <>
      {workspace.error || detail.error ? (
        <ReportError
          message={detail.error || workspace.error}
          onRetry={() => {
            workspace.reload();
            detail.reload();
          }}
        />
      ) : null}
      {detail.loading && !detail.report ? <ReportLoading /> : null}
      {detail.report ? <AnalyticsReport {...props} report={detail.report} /> : null}
    </>
  );
}

function AnalyticsFooter(props: {
  sourceNote: string;
  workspace: ReturnType<typeof useWorkspaceAnalytics>;
}): JSX.Element {
  const { sourceNote, workspace } = props;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-1 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <Activity className="size-3" /> {sourceNote}
      </span>
      <span>Active counts describe sessions, not unique people.</span>
      {workspace.data?.source !== 'local' && !workspace.connected ? (
        <span>Live connection reconnecting.</span>
      ) : null}
    </div>
  );
}

export function AnalyticsView(props: AnalyticsViewProps): JSX.Element {
  const { projects, project, ownerToken, onSelect, mode = 'web', onInstall } = props;
  const [range, setRange] = useState('24h');
  const [appId, setAppId] = useState(project.appId);
  const [environmentId, setEnvironmentId] = useState(project.environmentId);
  const [selected, setSelected] = useState('');
  const [metric, setMetric] = useState<'pageviews' | 'events'>(
    mode === 'events' ? 'events' : 'pageviews',
  );
  const workspace = useWorkspaceAnalytics(ownerToken);
  const detail = useBrowserReport(
    ownerToken,
    range,
    appId === 'all' ? '' : appId,
    appId === 'all' ? '' : environmentId,
    selected,
  );
  const report = detail.report;
  const totals = report?.series.reduce(
    (all, row) => ({ pageviews: all.pageviews + row.pageviews, events: all.events + row.events }),
    { pageviews: 0, events: 0 },
  );
  const active = activeSessionCount(workspace, appId, environmentId);
  const apps = projects.filter(
    (project, index) => projects.findIndex((row) => row.appId === project.appId) === index,
  );
  const environments = projects.filter((candidate) => candidate.appId === appId);
  const sourceNote =
    report?.source === 'local'
      ? 'Local development data'
      : report?.sampled
        ? 'Sampled event estimates'
        : 'Event totals may arrive later';
  const selectEvent = (event: string) => {
    setSelected(event);
    setMetric('events');
  };
  const totalsValue = totals ?? { pageviews: 0, events: 0 };
  return (
    <section aria-label="Workspace analytics" className="space-y-5">
      <ReportFilters
        apps={apps}
        environments={environments}
        appId={appId}
        environmentId={environmentId}
        range={range}
        selected={selected}
        onApp={(value) => {
          setAppId(value);
          setEnvironmentId(
            value === 'all'
              ? ''
              : (projects.find((candidate) => candidate.appId === value)?.environmentId ?? ''),
          );
          setSelected('');
        }}
        onEnvironment={(value) => {
          setEnvironmentId(value);
          setSelected('');
        }}
        onRange={setRange}
        onClearEvent={() => {
          setSelected('');
          setMetric(mode === 'events' ? 'events' : 'pageviews');
        }}
        onInstall={onInstall}
      />

      <AnalyticsResults
        workspace={workspace}
        detail={detail}
        mode={mode}
        selected={selected}
        metric={metric}
        range={range}
        sourceNote={sourceNote}
        active={active}
        totals={totalsValue}
        onMetric={setMetric}
        onEvent={selectEvent}
      />
      <ProjectRows projects={projects} summary={workspace.data} onSelect={onSelect} />
      <AnalyticsFooter sourceNote={sourceNote} workspace={workspace} />
    </section>
  );
}
