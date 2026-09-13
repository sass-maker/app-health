import type { BrowserSegmentFilter } from '@app-health/contracts';
import { AnalyticsSegments } from './AnalyticsSegments.js';
import { useState } from 'react';
import { Activity, ArrowRight, RefreshCw, X } from 'lucide-react';
import { AnalyticsReport, type AnalyticsReportProps } from './AnalyticsReport.js';
import { useBrowserReport, useWorkspaceAnalytics } from './useAnalytics.js';
import { Badge } from './components/ui/badge.js';
import { Button } from './components/ui/button.js';
import { Card, CardContent } from './components/ui/card.js';
import { LabeledSelect as ReportSelect } from './LabeledSelect.js';
import { AnalyticsReportLoading } from './AnalyticsReportLoading.js';

interface Project {
  appId: string;
  environmentId: string;
  name: string;
  environment: string;
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

interface AnalyticsViewProps {
  projects: Project[];
  project: Project;
  ownerToken: string;
  onSelect: (project: Project) => void;
  mode?: 'web' | 'events';
  onInstall?: () => void;
}

interface ReportFiltersProps {
  mode: 'web' | 'events';
  range: string;
  selected: string;
  onRange: (value: string) => void;
  onClearEvent: () => void;
  onInstall?: () => void;
}

function ReportFilters(props: ReportFiltersProps): JSX.Element {
  const { mode, range, selected, onRange, onClearEvent, onInstall } = props;
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-3 lg:flex-row lg:items-center">
      <div className="flex flex-1 flex-col gap-2 sm:flex-row">
        <ReportSelect
          label="Analytics period"
          value={range}
          onValueChange={onRange}
          triggerClassName="h-10 min-w-40"
          options={[
            { value: '24h', label: 'Last 24 hours' },
            { value: '1h', label: 'Last hour' },
            { value: '7d', label: 'Last 7 days' },
            { value: '30d', label: 'Last 30 days' },
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
        {mode === 'events' ? 'Install event tracking' : 'Install tracker'} <ArrowRight />
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
      {detail.loading && !detail.report ? <AnalyticsReportLoading /> : null}
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

function reportSourceNote(report: ReturnType<typeof useBrowserReport>['report']): string {
  if (report?.source === 'local') return 'Local development data';
  return report?.sampled ? 'Sampled analytics estimates' : 'Event totals may arrive later';
}

function reportTotals(report: ReturnType<typeof useBrowserReport>['report']) {
  return (report?.series ?? []).reduce(
    (total, row) => ({
      pageviews: total.pageviews + row.pageviews,
      events: total.events + row.events,
    }),
    { pageviews: 0, events: 0 },
  );
}

function useReportSelection(project: Project) {
  const [segments, setSegments] = useState<BrowserSegmentFilter>({});
  const { appId, environmentId } = project;
  const [selected, setSelected] = useState('');
  const removeSegment = (key: keyof BrowserSegmentFilter) =>
    setSegments((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  return {
    segments,
    setSegments,
    appId,
    environmentId,
    selected,
    setSelected,
    removeSegment,
  };
}

export function AnalyticsView(props: AnalyticsViewProps): JSX.Element {
  const { project, ownerToken, mode = 'web', onInstall } = props;
  const { segments, setSegments, appId, environmentId, selected, setSelected, removeSegment } =
    useReportSelection(project);
  const [range, setRange] = useState('24h');
  const [metric, setMetric] = useState<'pageviews' | 'events'>(
    mode === 'events' ? 'events' : 'pageviews',
  );
  const [breakdown, setBreakdown] = useState<'audience' | 'acquisition' | 'technology'>('audience');
  const workspace = useWorkspaceAnalytics(ownerToken);
  const detail = useBrowserReport(
    ownerToken,
    range,
    appId === 'all' ? '' : appId,
    appId === 'all' ? '' : environmentId,
    selected,
    { breakdown, segments },
  );
  const report = detail.report;
  const totalsValue = reportTotals(report);
  const active = activeSessionCount(workspace, appId, environmentId);
  const sourceNote = reportSourceNote(report);
  const selectEvent = (event: string) => {
    setSelected(event);
    setMetric('events');
  };
  return (
    <section aria-label="Workspace analytics" className="space-y-5 overflow-x-hidden">
      <ReportFilters
        mode={mode}
        range={range}
        selected={selected}
        onRange={setRange}
        onClearEvent={() => {
          setSelected('');
          setMetric(mode === 'events' ? 'events' : 'pageviews');
        }}
        onInstall={onInstall}
      />

      <AnalyticsSegments
        filters={segments}
        emptyHint={
          mode === 'events' && !selected
            ? 'Open a named event to reveal its page, source, and audience breakdowns.'
            : undefined
        }
        onClear={() => {
          setSegments({});
          setSelected('');
          setMetric(mode === 'events' ? 'events' : 'pageviews');
        }}
        onRemove={removeSegment}
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
        breakdown={breakdown}
        onBreakdown={setBreakdown}
        segmented={Object.keys(segments).length > 0}
        onFilter={(key, value) => setSegments((current) => ({ ...current, [key]: value }))}
      />
      <AnalyticsFooter sourceNote={sourceNote} workspace={workspace} />
    </section>
  );
}
