import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import { Badge } from '@saas-maker/ui/components/badge';
import { Button } from '@saas-maker/ui/components/button';
import { Input } from '@saas-maker/ui/components/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@saas-maker/ui/components/tabs';
import { ErrorState } from '@saas-maker/ui/components/error-state';
import { EmptyState } from '@saas-maker/ui/components/empty-state';
import { LabeledSelect } from './LabeledSelect.js';
import { ownerFetch } from './lib/owner-fetch.js';
import { dateLabel, EvidenceLink, SourceInventory } from './OperationsSources.js';
import {
  currentOperationsSnapshot,
  readOperationsSnapshot,
  type OperationsFeed,
  type OperationsObservation,
  type OperationsSnapshot,
} from './lib/operations-model.js';

type Audience = 'all' | 'public' | 'internal';
type WorkStatus = 'attention' | 'coverage' | 'all' | 'running' | 'resolved' | 'unknown';

function ObservationRow({
  entry,
  feed,
  projects,
}: {
  entry: OperationsObservation;
  feed: OperationsFeed;
  projects: OperationsSnapshot['projects'];
}): ReactElement {
  const names = feed.projectIds.map(
    (id) => projects.find((project) => project.id === id)?.name ?? id,
  );
  return (
    <li className="grid gap-3 border-b py-5 first:pt-0 sm:grid-cols-[28px_1fr_auto]">
      <span className={entry.severity === 'error' ? 'text-destructive' : 'text-muted-foreground'}>
        {entry.status === 'resolved' ? (
          <CheckCircle2 aria-hidden="true" className="size-5" />
        ) : (
          <AlertTriangle aria-hidden="true" className="size-5" />
        )}
      </span>
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={entry.severity === 'error' ? 'destructive' : 'outline'}>
            {entry.severity}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {entry.scope} · {entry.status}
          </span>
        </div>
        <h3 className="break-words text-sm font-medium">{entry.title}</h3>
        <p className="max-w-3xl break-words text-sm leading-relaxed text-muted-foreground">
          {entry.detail}
        </p>
        <p className="text-xs text-muted-foreground">
          {names.length ? names.join(', ') : 'Workspace-wide collector'} · {feed.producer}
        </p>
        {feed.freshness !== 'current' ? (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Retained finding. {feed.freshness} source evidence; current condition needs rechecking.
          </p>
        ) : null}
        <EvidenceLink url={entry.evidenceUrl} />
      </div>
      <time
        dateTime={entry.observedAt ?? undefined}
        className="text-xs text-muted-foreground sm:max-w-36 sm:text-right"
      >
        {dateLabel(entry.observedAt)}
      </time>
    </li>
  );
}
function selectOperations(
  snapshot: OperationsSnapshot,
  audience: Audience,
  familyId: string,
  status: WorkStatus,
  query: string,
) {
  const projects = snapshot.projects.filter(
    (project) => audience === 'all' || project.audience === audience,
  );
  const ids = new Set(projects.map((project) => project.id));
  const feeds = snapshot.feeds.filter(
    (feed) =>
      (!feed.projectIds.length || feed.projectIds.some((id) => ids.has(id))) &&
      (familyId === 'all' || feed.familyId === familyId),
  );
  const feedMap = new Map(feeds.map((feed) => [feed.id, feed]));
  const all = snapshot.observations.filter(
    (entry) => feedMap.has(entry.feedId) && (entry.projectId === null || ids.has(entry.projectId)),
  );
  const coverage = all.filter((entry) => feedMap.get(entry.feedId)?.health === 'unavailable');
  const actionable = all.filter(
    (entry) =>
      entry.severity !== 'info' && entry.status !== 'resolved' && !coverage.includes(entry),
  );
  const matches = all.filter(
    (entry) =>
      (status === 'all' ||
        (status === 'attention'
          ? actionable.includes(entry)
          : status === 'coverage'
            ? coverage.includes(entry)
            : entry.status === status)) &&
      `${entry.title} ${entry.detail} ${feedMap.get(entry.feedId)?.name}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const sourceCount = new Set(
    feeds.filter((feed) => feed.health !== 'unavailable').map((feed) => feed.familyId),
  ).size;
  const coverageGaps = feeds.filter(
    (feed) => feed.freshness !== 'current' || feed.health === 'unavailable',
  ).length;
  return {
    projects,
    feeds,
    feedMap,
    all,
    coverage,
    actionable,
    matches,
    sourceCount,
    coverageGaps,
  };
}
type OperationsSelection = ReturnType<typeof selectOperations>;
function SnapshotNotice({
  snapshot,
  loading,
  onRefresh,
}: {
  snapshot: OperationsSnapshot;
  loading: boolean;
  onRefresh: () => void;
}): ReactElement {
  return (
    <div className="flex flex-col justify-between gap-4 border-b pb-5 sm:flex-row sm:items-center">
      <div>
        <p className="text-sm font-medium">Observed sources, with their limits</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Snapshot collected {dateLabel(snapshot.generatedAt)}. Reload reads this snapshot; provider
          collection is a separate command.
        </p>
      </div>
      <Button
        variant="outline"
        disabled={loading}
        onClick={onRefresh}
        className="min-h-11 shrink-0"
      >
        <RefreshCw
          className={`size-4 ${loading ? 'animate-spin motion-reduce:animate-none' : ''}`}
        />{' '}
        reload snapshot
      </Button>
    </div>
  );
}
function OperationsTotals({
  snapshot,
  selection,
}: {
  snapshot: OperationsSnapshot;
  selection: OperationsSelection;
}): ReactElement {
  const { feeds, sourceCount, actionable, all, coverageGaps } = selection;
  return (
    <div
      className="grid divide-y rounded-lg border sm:grid-cols-3 sm:divide-x sm:divide-y-0"
      aria-label="Operations totals"
    >
      <Metric
        title="Source families observed"
        value={`${sourceCount} / ${snapshot.families.length}`}
        detail={`${feeds.length} feeds checked · ${feeds.filter((feed) => feed.health !== 'unavailable').length} with readable data`}
      />
      <Metric
        title="Needs attention"
        value={String(actionable.length)}
        detail={`${all.filter((entry) => entry.severity === 'info').length} informational observations kept separate`}
      />
      <Metric
        title="Collection coverage gaps"
        value={String(coverageGaps)}
        detail="Includes stale, missing and inaccessible feeds"
      />
    </div>
  );
}
function OperationsScope({
  snapshot,
  audience,
  setAudience,
  projects,
}: {
  snapshot: OperationsSnapshot;
  audience: Audience;
  setAudience: (audience: Audience) => void;
  projects: OperationsSnapshot['projects'];
}): ReactElement {
  const counts = (kind: string) => projects.filter((project) => project.kind === kind).length;
  return (
    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
      <div role="group" aria-label="Audience scope" className="flex flex-wrap gap-2">
        {(['all', 'public', 'internal'] as const).map((value) => (
          <Button
            key={value}
            variant={audience === value ? 'secondary' : 'outline'}
            aria-pressed={audience === value}
            className="min-h-11"
            onClick={() => setAudience(value)}
          >
            {value}{' '}
            <span className="tabular-nums text-muted-foreground">
              {
                snapshot.projects.filter((project) => value === 'all' || project.audience === value)
                  .length
              }
            </span>
          </Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {counts('product')} products · {counts('experiment')} experiments · {counts('platform')}{' '}
        platforms
      </p>
    </div>
  );
}
interface ToolbarProps {
  snapshot: OperationsSnapshot;
  familyId: string;
  setFamilyId: (value: string) => void;
  status: WorkStatus;
  setStatus: (value: WorkStatus) => void;
  query: string;
  setQuery: (value: string) => void;
  coverageCount: number;
}
function OperationsToolbar(props: ToolbarProps): ReactElement {
  const { snapshot, familyId, setFamilyId, status, setStatus, query, setQuery, coverageCount } =
    props;
  return (
    <div className="grid items-end gap-3 xl:grid-cols-[1fr_240px_200px]">
      <label className="space-y-1.5 text-xs font-medium">
        <span>Search observations</span>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="project, failure or source…"
          className="min-h-11"
        />
      </label>
      <LabeledSelect
        label="Source family"
        triggerClassName="min-h-11 w-full"
        value={familyId}
        options={[
          { value: 'all', label: 'all source families' },
          ...snapshot.families.map((family) => ({ value: family.id, label: family.name })),
        ]}
        onValueChange={setFamilyId}
      />
      <LabeledSelect
        label="Observation status"
        triggerClassName="min-h-11 w-full"
        value={status}
        options={[
          { value: 'attention', label: 'needs attention' },
          { value: 'coverage', label: `access gaps (${coverageCount})` },
          { value: 'all', label: 'all observations' },
          { value: 'running', label: 'running' },
          { value: 'unknown', label: 'unknown / coverage' },
          { value: 'resolved', label: 'resolved' },
        ]}
        onValueChange={(value) => setStatus(value as WorkStatus)}
      />
    </div>
  );
}
function OperationsReports({
  snapshot,
  selection,
  familyId,
}: {
  snapshot: OperationsSnapshot;
  selection: OperationsSelection;
  familyId: string;
}): ReactElement {
  const { matches, sourceCount, feedMap, feeds } = selection;
  return (
    <Tabs defaultValue="attention" className="gap-5">
      <TabsList aria-label="Operations reports" className="w-full sm:w-auto">
        <TabsTrigger value="attention">
          observations <span className="ml-1 tabular-nums">{matches.length}</span>
        </TabsTrigger>
        <TabsTrigger value="sources">
          sources <span className="ml-1 tabular-nums">{sourceCount}</span>
        </TabsTrigger>
      </TabsList>
      <TabsContent value="attention">
        {matches.length ? (
          <ol aria-label="Operational observations">
            {matches
              .sort(
                (a, b) =>
                  ({ error: 0, warning: 1, info: 2 })[a.severity] -
                  { error: 0, warning: 1, info: 2 }[b.severity],
              )
              .map((entry) => (
                <ObservationRow
                  key={entry.id}
                  entry={entry}
                  feed={feedMap.get(entry.feedId)!}
                  projects={snapshot.projects}
                />
              ))}
          </ol>
        ) : (
          <EmptyState
            title="No observations match this view."
            description="This is a filtered snapshot. Check source coverage before concluding that every product is healthy."
          />
        )}
      </TabsContent>
      <TabsContent value="sources">
        <SourceInventory snapshot={snapshot} feeds={feeds} familyId={familyId} />
      </TabsContent>
    </Tabs>
  );
}
function OperationsData({
  data,
  loading,
  onRefresh,
}: {
  data: OperationsSnapshot;
  loading: boolean;
  onRefresh: () => void;
}): ReactElement {
  const [audience, setAudience] = useState<Audience>('all');
  const [familyId, setFamilyId] = useState('all');
  const [status, setStatus] = useState<WorkStatus>('attention');
  const [query, setQuery] = useState('');
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const snapshot = useMemo(() => currentOperationsSnapshot(data, now), [data, now]);
  const selection = selectOperations(snapshot, audience, familyId, status, query);
  return (
    <div className="space-y-6">
      <SnapshotNotice snapshot={snapshot} loading={loading} onRefresh={onRefresh} />
      <OperationsTotals snapshot={snapshot} selection={selection} />
      <OperationsScope
        snapshot={snapshot}
        audience={audience}
        setAudience={setAudience}
        projects={selection.projects}
      />
      <OperationsToolbar
        snapshot={snapshot}
        familyId={familyId}
        setFamilyId={setFamilyId}
        status={status}
        setStatus={setStatus}
        query={query}
        setQuery={setQuery}
        coverageCount={selection.coverage.length}
      />
      <OperationsReports snapshot={snapshot} selection={selection} familyId={familyId} />
      <p className="border-t pt-4 text-xs leading-relaxed text-muted-foreground">
        Workspace-wide collector findings remain visible in public and internal views. Private
        source inputs stay on this machine. This dashboard does not send email, start repairs or
        mark production recovery from a merged PR.
      </p>
    </div>
  );
}
function Metric({
  title,
  value,
  detail,
}: {
  title: string;
  value: string;
  detail: string;
}): ReactElement {
  return (
    <div className="px-5 py-4">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{detail}</p>
    </div>
  );
}
export function OperationsView({ ownerToken }: { ownerToken: string }): ReactElement {
  const [state, setState] = useState<{
    token: string;
    data: OperationsSnapshot | null;
    error: string;
    loading: boolean;
    unavailable: boolean;
  }>({ token: ownerToken, data: null, error: '', loading: true, unavailable: false });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    setState({ token: ownerToken, data: null, error: '', loading: true, unavailable: false });
    const timer = window.setTimeout(() => controller.abort(), 10_000);
    void ownerFetch('/v1/workspace/operations', ownerToken, { signal: controller.signal })
      .then(async (response) => {
        if (response.status === 404) {
          if (!disposed)
            setState({
              token: ownerToken,
              data: null,
              error: '',
              loading: false,
              unavailable: true,
            });
          return;
        }
        if (!response.ok)
          throw new Error(
            `Source snapshot returned ${response.status}. Collect the sources again, then reload.`,
          );
        const data = readOperationsSnapshot(await response.json());
        if (!disposed)
          setState({ token: ownerToken, data, error: '', loading: false, unavailable: false });
      })
      .catch((error: unknown) => {
        if (!disposed)
          setState({
            token: ownerToken,
            data: null,
            error: controller.signal.aborted
              ? 'Source snapshot request timed out. Try again.'
              : error instanceof Error
                ? error.message
                : 'Source snapshot unavailable.',
            loading: false,
            unavailable: false,
          });
      })
      .finally(() => window.clearTimeout(timer));
    return () => {
      disposed = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [ownerToken, revision]);
  const refresh = () => setRevision((value) => value + 1);
  if (state.token !== ownerToken || state.loading)
    return (
      <div role="status" className="py-16 text-sm text-muted-foreground">
        Reading the collected operations sources…
      </div>
    );
  if (state.error)
    return (
      <ErrorState
        title="Operations sources are unavailable"
        description={state.error}
        onRetry={refresh}
      />
    );
  if (state.unavailable || !state.data)
    return (
      <EmptyState
        title="Operations sources are not connected here."
        description="This view reads an explicitly configured private snapshot in the local owner preview. Production sources have not been activated."
      />
    );
  return <OperationsData data={state.data} loading={state.loading} onRefresh={refresh} />;
}
