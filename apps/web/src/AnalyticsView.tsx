import { BrowserTrafficPolicy } from './BrowserTrafficPolicy.js';
import { BrowserReportFilter, type BrowserSegmentFilter } from '@app-health/contracts';
import { AnalyticsSegments } from './AnalyticsSegments.js';
import { Conversions, SavedSegments } from './Conversions.js';
import { Revenue } from './Revenue.js';
import { useState, type ReactElement } from 'react';
import { Activity, ArrowRight, X } from 'lucide-react';
import { AnalyticsReport, type AnalyticsReportProps } from './AnalyticsReport.js';
import { useBrowserReport, useWorkspaceAnalytics } from './useAnalytics.js';
import { Badge } from '@saas-maker/ui/components/badge';
import { Button } from '@saas-maker/ui/components/button';
import { ErrorState } from '@saas-maker/ui/components/error-state';
import { FilterBar } from '@saas-maker/ui/blocks/filter-bar';
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
    <ErrorState
      title="analytics could not refresh"
      description={message}
      onRetry={onRetry}
      className="rounded-lg border border-destructive/40 bg-destructive/5"
    />
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

function briefingSelection() {
  const params = new URLSearchParams(location.search);
  const parsed = BrowserReportFilter.safeParse({
    range: '24h',
    date: params.get('briefing_date') ?? undefined,
    source: params.get('briefing_source') ?? undefined,
  });
  return parsed.success
    ? parsed.data
    : { range: '24h' as const, date: undefined, source: undefined };
}

interface ReportFiltersProps {
  mode: 'web' | 'events';
  range: string;
  selected: string;
  onRange: (value: string) => void;
  onClearEvent: () => void;
  date?: string;
  onInstall?: () => void;
}

function ReportFilters(props: ReportFiltersProps): ReactElement {
  const { mode, range, selected, onRange, onClearEvent, onInstall, date } = props;
  return (
    <FilterBar className="flex-col gap-3 rounded-lg border bg-card p-3 lg:flex-row lg:items-center">
      <div className="flex flex-1 flex-col gap-2 sm:flex-row">
        <ReportSelect
          label="Analytics period"
          value={date ? 'briefing' : range}
          onValueChange={onRange}
          triggerClassName="h-10 min-w-40"
          options={[
            ...(date ? [{ value: 'briefing', label: `${date} · India day` }] : []),
            { value: '24h', label: 'last 24 hours' },
            { value: '1h', label: 'last hour' },
            { value: '7d', label: 'last 7 days' },
            { value: '30d', label: 'last 30 days' },
          ]}
        />
      </div>
      <BrowserTrafficPolicy />
      {selected ? (
        <Badge variant="secondary" className="h-10 max-w-full gap-2 px-3 font-mono font-normal">
          <span className="truncate">{selected}</span>
          <button aria-label="Clear event filter" onClick={onClearEvent}>
            <X className="size-3.5" />
          </button>
        </Badge>
      ) : null}
      <Button variant="outline" className="h-10 w-full lg:w-auto" onClick={onInstall}>
        {mode === 'events' ? 'install event tracking' : 'install tracker'} <ArrowRight />
      </Button>
    </FilterBar>
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

function AnalyticsResults(props: AnalyticsResultsProps): ReactElement {
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
}): ReactElement {
  const { sourceNote, workspace } = props;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-1 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <Activity className="size-3" /> {sourceNote}
      </span>
      <span>active counts describe sessions, not unique people.</span>
      {workspace.data?.source !== 'local' && !workspace.connected ? (
        <span>live connection reconnecting.</span>
      ) : null}
    </div>
  );
}

function reportSourceNote(report: ReturnType<typeof useBrowserReport>['report']): string {
  if (report?.source === 'local') return 'local development data';
  return report?.sampled ? 'sampled analytics estimates' : 'event totals may arrive later';
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
  const [segments, setSegments] = useState<BrowserSegmentFilter>(() => {
    const selected = briefingSelection();
    return selected.source ? { source: selected.source } : {};
  });
  const { appId, environmentId } = project;
  const [selected, setSelected] = useState('');
  const removeSegment = (key: keyof BrowserSegmentFilter) => {
    if (key === 'source') {
      const url = new URL(location.href);
      url.searchParams.delete('briefing_source');
      history.replaceState(null, '', url);
    }
    setSegments((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  };
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

function useReportController(props: AnalyticsViewProps) {
  const { project, ownerToken, mode = 'web' } = props;
  const { segments, setSegments, appId, environmentId, selected, setSelected, removeSegment } =
    useReportSelection(project);
  const [range, setRange] = useState('24h');
  const [date, setDate] = useState<string | undefined>(() => briefingSelection().date);
  const [metric, setMetric] = useState<'pageviews' | 'events'>(
    mode === 'events' ? 'events' : 'pageviews',
  );
  const [breakdown, setBreakdown] = useState<'audience' | 'acquisition' | 'technology'>(() =>
    briefingSelection().source ? 'acquisition' : 'audience',
  );
  const workspace = useWorkspaceAnalytics(ownerToken);
  const detail = useBrowserReport(
    ownerToken,
    range,
    appId === 'all' ? '' : appId,
    appId === 'all' ? '' : environmentId,
    selected,
    { breakdown, segments, date },
  );
  const report = detail.report;
  const totalsValue = reportTotals(report);
  const active = activeSessionCount(workspace, appId, environmentId);
  const sourceNote = reportSourceNote(report);
  const selectEvent = (event: string) => {
    setSelected(event);
    setMetric('events');
  };
  return {
    segments,
    setSegments,
    appId,
    environmentId,
    selected,
    setSelected,
    removeSegment,
    range,
    setRange,
    date,
    setDate,
    metric,
    setMetric,
    breakdown,
    setBreakdown,
    workspace,
    detail,
    totalsValue,
    active,
    sourceNote,
    selectEvent,
  };
}

export function AnalyticsView(props: AnalyticsViewProps): ReactElement {
  const { ownerToken, mode = 'web', onInstall } = props;
  const v = useReportController(props);
  const query = {
    app_id: v.appId,
    environment_id: v.environmentId,
    range: v.range as '1h' | '24h' | '7d' | '30d',
    filters: v.segments,
  };
  const scopeKey = `${ownerToken}:${v.appId}:${v.environmentId}`;
  return (
    <section aria-label="Workspace analytics" className="space-y-5 overflow-x-hidden">
      <ReportFilters
        mode={mode}
        range={v.range}
        selected={v.selected}
        date={v.date}
        onRange={(next) => {
          if (next === 'briefing') return;
          v.setDate(undefined);
          const url = new URL(location.href);
          url.searchParams.delete('briefing_date');
          history.replaceState(null, '', url);
          v.setRange(next);
        }}
        onClearEvent={() => {
          v.setSelected('');
          v.setMetric(mode === 'events' ? 'events' : 'pageviews');
        }}
        onInstall={onInstall}
      />
      <AnalyticsSegments
        filters={v.segments}
        emptyHint={
          mode === 'events' && !v.selected
            ? 'open a named event to reveal its page, source, and audience breakdowns.'
            : undefined
        }
        onClear={() => {
          const url = new URL(location.href);
          url.searchParams.delete('briefing_source');
          history.replaceState(null, '', url);
          v.setSegments({});
          v.setSelected('');
          v.setMetric(mode === 'events' ? 'events' : 'pageviews');
        }}
        onRemove={v.removeSegment}
      />
      {v.appId !== 'all' ? (
        <SavedSegments
          key={`segments:${scopeKey}`}
          query={query}
          ownerToken={ownerToken}
          onApply={v.setSegments}
        />
      ) : null}
      <AnalyticsResults
        workspace={v.workspace}
        detail={v.detail}
        mode={mode}
        selected={v.selected}
        metric={v.metric}
        range={v.range}
        date={v.date}
        sourceNote={v.sourceNote}
        active={v.active}
        totals={v.totalsValue}
        onMetric={v.setMetric}
        onEvent={v.selectEvent}
        breakdown={v.breakdown}
        onBreakdown={v.setBreakdown}
        segmented={Object.keys(v.segments).length > 0}
        onFilter={(key, value) => v.setSegments((current) => ({ ...current, [key]: value }))}
      />
      <AnalyticsFooter sourceNote={v.sourceNote} workspace={v.workspace} />
      {v.appId !== 'all' && mode === 'events' && !v.date ? (
        <>
          <Conversions
            key={`conversions:${scopeKey}`}
            query={{ ...query, event: v.selected || undefined }}
            ownerToken={ownerToken}
          />
          <Revenue key={`revenue:${scopeKey}`} query={query} ownerToken={ownerToken} />
        </>
      ) : null}
    </section>
  );
}
