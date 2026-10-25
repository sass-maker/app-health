import { useWorkspaceScope, workspaceCanManage, WorkspaceManage } from './lib/workspace-scope.js';
import { useEffect, useState } from 'react';
import {
  AnalysisRecord,
  AnalysisRecords,
  AnalysisReport,
  type AnalysisDefinition,
  type AnalysisQuery,
} from '@app-health/contracts';
import { Button } from '@saas-maker/ui/components/button';
import { Card, CardContent, CardHeader } from '@saas-maker/ui/components/card';
import { ConversionEditor } from './ConversionEditor.js';
import { apiUrl, ownerFetch } from './lib/owner-fetch.js';

const percent = (value: number | null) => (value === null ? '—' : `${(value * 100).toFixed(1)}%`);
function queryString(query: AnalysisQuery) {
  const params = new URLSearchParams({
    app_id: query.app_id,
    environment_id: query.environment_id,
    range: query.range,
  });
  if (query.event) params.set('event', query.event);
  if (query.filters && Object.keys(query.filters).length)
    params.set('filters', JSON.stringify(query.filters));
  return params.toString();
}

function GoalRows({
  report,
  onDelete,
  onEdit,
  busy,
}: {
  report: AnalysisReport;
  onDelete: (id: string) => void;
  onEdit: (id: string) => void;
  busy: boolean;
}) {
  return (
    <div className="grid gap-3 xl:grid-cols-2">
      {report.goals.map((goal) => (
        <div key={goal.id} className="min-w-0 rounded-lg border p-4">
          <div className="flex items-start justify-between gap-2">
            <h3 className="break-words text-sm font-medium">{goal.name}</h3>
            <WorkspaceManage>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => onEdit(goal.id)}
                aria-label={`Edit ${goal.name}`}
              >
                edit
              </Button>
            </WorkspaceManage>
            <WorkspaceManage>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => onDelete(goal.id)}
                aria-label={`Delete ${goal.name}`}
              >
                delete
              </Button>
            </WorkspaceManage>
          </div>
          <p className="mt-2 text-2xl font-semibold tabular-nums">
            {percent(goal.conversion_rate)}
          </p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {goal.visitors.toLocaleString()} converted recognized browsers ·{' '}
            {goal.sessions.toLocaleString()} sessions · {goal.occurrences.toLocaleString()}{' '}
            occurrences
          </p>
          <p className="text-xs leading-5 text-muted-foreground">
            event value {goal.value.toLocaleString()} · browser conversion rate excludes
            unidentified sessions
          </p>
        </div>
      ))}
    </div>
  );
}
function FunnelRows({
  report,
  onDelete,
  onEdit,
  busy,
}: {
  report: AnalysisReport;
  onDelete: (id: string) => void;
  onEdit: (id: string) => void;
  busy: boolean;
}) {
  return (
    <div className="space-y-3">
      {report.funnels.map((funnel) => (
        <div key={funnel.id} className="rounded-lg border p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h3 className="text-sm font-medium">{funnel.name}</h3>
            <WorkspaceManage>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => onEdit(funnel.id)}
                aria-label={`Edit ${funnel.name}`}
              >
                edit
              </Button>
            </WorkspaceManage>
            <WorkspaceManage>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => onDelete(funnel.id)}
                aria-label={`Delete ${funnel.name}`}
              >
                delete
              </Button>
            </WorkspaceManage>
          </div>
          <p className="my-2 text-xs text-muted-foreground">
            {percent(funnel.conversion_rate)} of starting sessions completed
            {funnel.median_conversion_ms === null
              ? ''
              : ` · median ${(funnel.median_conversion_ms / 1000).toLocaleString()} seconds`}
          </p>
          <ol className="divide-y">
            {funnel.steps.map((step, index) => (
              <li
                key={index}
                className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs"
              >
                <span className="min-w-0 break-all font-mono">
                  {index + 1}. {step.target}
                </span>
                <span className="tabular-nums">
                  {step.sessions.toLocaleString()} sessions
                  {index
                    ? ` · ${step.dropoff.toLocaleString()} dropped · ${percent(step.conversion_rate)} continued`
                    : ''}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

type ConversionProps = { query: AnalysisQuery; ownerToken: string };
type EditingState =
  | { kind: 'new' }
  | { kind: 'existing'; id: string; definition: Exclude<AnalysisDefinition, { kind: 'segment' }> };

export function Conversions(props: ConversionProps) {
  return (
    <ScopedConversions
      key={`${props.ownerToken}:${props.query.app_id}:${props.query.environment_id}`}
      {...props}
    />
  );
}

function ScopedConversions({ query, ownerToken }: ConversionProps) {
  const readOnly = !workspaceCanManage(useWorkspaceScope().role);
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<{ key: string; data: AnalysisReport } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [definitions, setDefinitions] = useState<AnalysisRecord[]>([]);
  const params = queryString(query);
  const key = `${ownerToken}:${params}`;
  const data = report?.key === key ? report.data : null;
  const scope = new URLSearchParams({
    app_id: query.app_id,
    environment_id: query.environment_id,
  }).toString();
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void ownerFetch(apiUrl(`/v1/analytics/conversions?${params}`), ownerToken, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            'Conversions could not load. The archive may still be processing, or this period may exceed the scan limit. Try a shorter period.',
          );
        const result = AnalysisReport.parse(await response.json());
        if (!controller.signal.aborted) setReport({ key, data: result });
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setReport(null);
          setError(cause instanceof Error ? cause.message : 'Conversions could not load.');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, params, ownerToken, key, revision]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void ownerFetch(apiUrl(`/v1/analytics/definitions?${scope}`), ownerToken, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Conversion definitions could not load.');
        const result = AnalysisRecords.parse(await response.json());
        if (!controller.signal.aborted) setDefinitions(result.records);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setDefinitions([]);
          setError('Conversion definitions could not load. Refresh before editing.');
        }
      });
    return () => controller.abort();
  }, [open, scope, ownerToken, revision]);
  function edit(id: string) {
    if (readOnly) {
      return;
    }
    const record = definitions.find((row) => row.id === id);
    if (!record || record.definition.kind === 'segment') {
      setError('Original definition unavailable. Refresh before editing.');
      return;
    }
    setEditing({ kind: 'existing', id, definition: record.definition });
  }
  async function save(definition: AnalysisDefinition) {
    if (readOnly) {
      return;
    }
    setBusy(true);
    try {
      const id = editing?.kind === 'existing' ? `/${encodeURIComponent(editing.id)}` : '';
      const response = await ownerFetch(
        apiUrl(`/v1/analytics/definitions${id}?${scope}`),
        ownerToken,
        {
          method: id ? 'PUT' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(definition),
        },
      );
      if (!response.ok) {
        const failure = (await response.json()) as { error?: string };
        throw new Error(
          response.status === 409
            ? (failure.error ?? 'The workspace has reached its definition limit.')
            : 'Definition was not saved',
        );
      }
      AnalysisRecord.parse(await response.json());
      setEditing(null);
      setRevision((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    if (readOnly) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      const response = await ownerFetch(
        apiUrl(`/v1/analytics/definitions/${encodeURIComponent(id)}?${scope}`),
        ownerToken,
        { method: 'DELETE' },
      );
      if (!response.ok) throw new Error('Could not delete the definition.');
      setRevision((value) => value + 1);
    } catch {
      setError('Could not delete the definition.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="shadow-none">
      <CardHeader className="flex flex-wrap items-center justify-between gap-3 sm:flex-row">
        <div>
          <h2 className="text-sm font-semibold">goals, funnels & event properties</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            understand which actions turn a visit into a conversion.
          </p>
        </div>
        <Button variant="outline" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          {open ? 'hide conversions' : 'explore conversions'}
        </Button>
      </CardHeader>
      {open ? (
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <WorkspaceManage>
              <Button
                variant="outline"
                disabled={readOnly}
                onClick={() => setEditing((value) => (value ? null : { kind: 'new' }))}
              >
                {editing ? 'cancel' : 'new goal or funnel'}
              </Button>
            </WorkspaceManage>
            <Button
              variant="ghost"
              onClick={() => setRevision((value) => value + 1)}
              disabled={loading}
            >
              refresh conversions
            </Button>
          </div>
          {editing ? (
            <WorkspaceManage>
              <ConversionEditor
                key={editing.kind === 'existing' ? editing.id : 'new'}
                initial={editing.kind === 'existing' ? editing.definition : undefined}
                onSave={save}
                busy={busy || readOnly}
              />
            </WorkspaceManage>
          ) : null}
          {loading ? (
            <p role="status" className="text-xs text-muted-foreground">
              reading conversion events…
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {data ? (
            <>
              <p className="rounded-lg bg-muted p-3 text-xs leading-5 text-muted-foreground">
                {data.coverage_note} Funnels require strictly increasing event timestamps within the
                same session. Filters qualify the first step; later steps retain the session.
              </p>
              <GoalRows
                report={data}
                onDelete={(id) => void remove(id)}
                onEdit={edit}
                busy={busy || readOnly}
              />
              <FunnelRows
                report={data}
                onDelete={(id) => void remove(id)}
                onEdit={edit}
                busy={busy || readOnly}
              />
              {!data.goals.length && !data.funnels.length ? (
                <p className="text-sm text-muted-foreground">
                  create a goal from an event or page, or connect two to eight steps in a funnel.
                </p>
              ) : null}
              {query.event ? <EventProperties report={data} /> : null}
            </>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}

function EventProperties({ report }: { report: AnalysisReport }) {
  return (
    <div className="space-y-3 border-t pt-4">
      <h3 className="text-sm font-medium">event properties & values</h3>
      {report.property_detail?.truncated ? (
        <p className="text-xs text-muted-foreground">
          Property detail is bounded. {report.property_detail.omitted_occurrences.toLocaleString()}{' '}
          property observations were omitted. These are retained buckets, not the top values. Goals
          and funnels still use all nonconflicting observed events.
        </p>
      ) : null}
      {report.values.map((row) => (
        <p key={row.name} className="break-all text-xs">
          {row.name}: {row.occurrences.toLocaleString()} occurrences · value{' '}
          {row.value.toLocaleString()}
        </p>
      ))}
      {report.properties.map((property) => (
        <div key={property.key} className="rounded-lg border p-3">
          <h4 className="font-mono text-xs">{property.key}</h4>
          <ul className="mt-2 space-y-1">
            {property.values.map((row, index) => (
              <li key={index} className="flex justify-between gap-3 text-xs">
                <span className="min-w-0 break-all">
                  {String(row.value)}{' '}
                  <span className="text-muted-foreground">({typeof row.value})</span>
                </span>
                <span>{row.count.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {!report.properties.length ? (
        <p className="text-xs text-muted-foreground">
          no properties were received for this event in the archived period.
        </p>
      ) : null}
    </div>
  );
}

type SegmentProps = ConversionProps & {
  onApply: (filters: NonNullable<AnalysisQuery['filters']>) => void;
};

export function SavedSegments(props: SegmentProps) {
  return (
    <ScopedSavedSegments
      key={`${props.ownerToken}:${props.query.app_id}:${props.query.environment_id}`}
      {...props}
    />
  );
}

function ScopedSavedSegments({
  query,
  ownerToken,
  onApply,
}: {
  query: AnalysisQuery;
  ownerToken: string;
  onApply: (filters: NonNullable<AnalysisQuery['filters']>) => void;
}) {
  const readOnly = !workspaceCanManage(useWorkspaceScope().role);
  const [open, setOpen] = useState(false);
  const [records, setRecords] = useState<{ key: string; rows: AnalysisRecord[] } | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const scope = new URLSearchParams({
    app_id: query.app_id,
    environment_id: query.environment_id,
  }).toString();
  const key = `${ownerToken}:${scope}`;
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setError('');
    void ownerFetch(apiUrl(`/v1/analytics/definitions?${scope}`), ownerToken, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Saved segments could not load.');
        const result = AnalysisRecords.parse(await response.json());
        if (!controller.signal.aborted)
          setRecords({
            key,
            rows: result.records.filter((row) => row.definition.kind === 'segment'),
          });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setRecords(null);
          setError('Saved segments could not load.');
        }
      });
    return () => controller.abort();
  }, [open, ownerToken, scope, key, revision]);
  async function mutate(id?: string) {
    if (readOnly) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      const response = await ownerFetch(
        apiUrl(`/v1/analytics/definitions${id ? `/${encodeURIComponent(id)}` : ''}?${scope}`),
        ownerToken,
        {
          method: id ? 'DELETE' : 'POST',
          headers: { 'content-type': 'application/json' },
          ...(id
            ? {}
            : { body: JSON.stringify({ kind: 'segment', name, filters: query.filters ?? {} }) }),
        },
      );
      if (!response.ok) throw new Error('Could not update saved segments.');
      setName('');
      setRevision((value) => value + 1);
    } catch {
      setError('Could not update saved segments.');
    } finally {
      setBusy(false);
    }
  }
  const rows = records?.key === key ? records.rows : [];
  return (
    <div className="space-y-2" aria-label="Saved segments">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {open ? 'hide saved segments' : 'saved segments'}
      </Button>
      {open ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {rows.map((row) => (
              <span key={row.id} className="inline-flex max-w-full items-center rounded-md border">
                <Button
                  variant="ghost"
                  size="sm"
                  className="max-w-52 truncate"
                  onClick={() => {
                    if (row.definition.kind === 'segment') onApply(row.definition.filters);
                  }}
                >
                  {row.definition.name}
                </Button>
                <WorkspaceManage>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || readOnly}
                    onClick={() => void mutate(row.id)}
                    aria-label={`Delete segment ${row.definition.name}`}
                  >
                    ×
                  </Button>
                </WorkspaceManage>
              </span>
            ))}
          </div>
          {query.filters && Object.keys(query.filters).length ? (
            <WorkspaceManage>
              <form
                aria-label="Save current filters as a segment"
                onSubmit={(event) => {
                  event.preventDefault();
                  void mutate();
                }}
                className="flex flex-wrap gap-2"
              >
                <input
                  aria-label="Segment name"
                  value={name}
                  maxLength={80}
                  required
                  placeholder="Name these filters"
                  onChange={(event) => setName(event.target.value)}
                  className="h-9 min-w-0 rounded-md border bg-background px-3 text-sm"
                />
                <Button type="submit" variant="outline" size="sm" disabled={busy || readOnly}>
                  save segment
                </Button>
              </form>
            </WorkspaceManage>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
