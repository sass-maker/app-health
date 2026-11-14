import { useEffect, useRef, useState } from 'react';
import {
  MonitoringPolicyV1,
  MonitoringReportV1,
  type MonitoringReport,
} from '@app-health/contracts';
import { RefreshCw } from 'lucide-react';
import { Badge } from '@saas-maker/ui/components/badge';
import { Button } from '@saas-maker/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@saas-maker/ui/components/card';
import { ownerFetch } from './lib/owner-fetch.js';
import { useWorkspaceScope, workspaceScope } from './lib/workspace-scope.js';

type Project = MonitoringReport['projects'][number];
const labels: Record<Project['state'], string> = {
  healthy: 'healthy',
  degraded: 'slow',
  failing: 'failing',
  stale: 'stale checks',
  missing: 'missing checks',
  offline: 'probe offline',
  unconfigured: 'project not linked',
  local: 'local · not checked',
  private: 'private · not checked',
};

function MonitoringProject({ project }: { project: Project }) {
  const fresh = project.checks.filter((check) => check.freshness === 'fresh').length;
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">{project.name}</p>
          <p className="text-xs text-muted-foreground">{project.catalog_id}</p>
        </div>
        <Badge
          variant={['failing', 'degraded'].includes(project.state) ? 'destructive' : 'secondary'}
        >
          {labels[project.state]}
        </Badge>
      </div>
      {project.scope === 'public' ? (
        <details className="mt-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer">
            {fresh}/{project.checks.length} public checks reporting
          </summary>
          <ul className="mt-2 space-y-2 border-l pl-3" aria-label={`${project.name} checks`}>
            {project.checks.map((check) => (
              <li key={check.journey}>
                <span className="font-medium text-foreground">{check.journey}</span>
                {' · '}
                {check.freshness}
                {check.health ? ` · ${check.health}` : ''}
                {check.observations.length ? (
                  <ul className="mt-1 space-y-1">
                    {check.observations.map((observation) => (
                      <li key={observation.location} className="break-words">
                        {observation.location}
                        {' · '}
                        {observation.freshness}
                        {' · '}
                        <time dateTime={new Date(observation.last_seen_at).toISOString()}>
                          {new Date(observation.last_seen_at).toLocaleString()}
                        </time>
                        {observation.failure ? ` · ${observation.failure}` : ''}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>No accepted check result.</p>
                )}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {project.reason ? (
        <p className="mt-2 text-xs text-muted-foreground">{project.reason}</p>
      ) : null}
    </li>
  );
}

function useMonitoringReport(ownerToken: string) {
  const scope = useWorkspaceScope();
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{
    epoch: number;
    token: string;
    report: MonitoringReport | null;
    error: string;
    loading: boolean;
  }>({ epoch: scope.epoch, token: ownerToken, report: null, error: '', loading: true });
  const current = result.epoch === scope.epoch && result.token === ownerToken ? result : null;
  const report = current?.report;
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const update = (report: MonitoringReport | null, error: string, loading: boolean) => {
      if (!disposed) setResult({ epoch: scope.epoch, token: ownerToken, report, error, loading });
    };
    update(null, '', true);
    const timeout = window.setTimeout(() => {
      controller.abort();
      update(null, 'Monitoring request timed out. Try again.', false);
    }, 10000);
    void ownerFetch('/v1/workspace/monitoring', ownerToken, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Monitoring returned ${response.status}. Try again.`);
        return MonitoringReportV1.parse(await response.json());
      })
      .then((value) => {
        if (!controller.signal.aborted) update(value, '', false);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          update(
            null,
            error instanceof Error ? error.message : 'Monitoring is unavailable.',
            false,
          );
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      disposed = true;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [scope.epoch, ownerToken, retry]);
  useEffect(() => {
    const refresh = () => setRetry((value) => value + 1);
    const timer = window.setInterval(refresh, 60000);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, []);
  return { current, report, refresh: () => setRetry((value) => value + 1) };
}

function useMonitoringImport(ownerToken: string, refresh: () => void) {
  const scope = useWorkspaceScope();
  const fileInput = useRef<HTMLInputElement>(null);
  const activeImport = useRef<AbortController | null>(null);
  const [upload, setUpload] = useState({ epoch: scope.epoch, busy: false, message: '' });
  useEffect(() => () => activeImport.current?.abort(), [scope.epoch, ownerToken]);
  async function importRoster(file: File) {
    const epoch = scope.epoch;
    const controller = new AbortController();
    activeImport.current?.abort();
    activeImport.current = controller;
    setUpload({ epoch, busy: true, message: '' });
    try {
      if (file.size > 65536) throw new Error('The monitoring roster must be smaller than 64 KiB.');
      let policy;
      try {
        policy = MonitoringPolicyV1.parse(JSON.parse(await file.text()));
      } catch {
        throw new Error('Choose a valid monitoring roster JSON file.');
      }
      if (controller.signal.aborted || workspaceScope().epoch !== epoch) return;
      const response = await ownerFetch('/v1/workspace/monitoring/policy', ownerToken, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(policy),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`The roster could not be saved (${response.status}).`);
      if (controller.signal.aborted || workspaceScope().epoch !== epoch) return;
      setUpload({ epoch, busy: false, message: 'Roster saved. Check results establish coverage.' });
      refresh();
    } catch (error) {
      if (!controller.signal.aborted && workspaceScope().epoch === epoch)
        setUpload({
          epoch,
          busy: false,
          message: error instanceof Error ? error.message : 'The roster could not be saved.',
        });
    } finally {
      if (activeImport.current === controller && fileInput.current) fileInput.current.value = '';
    }
  }
  return { scope, fileInput, upload, importRoster };
}

type MonitoringImport = ReturnType<typeof useMonitoringImport>;
function MonitoringHeader({
  ownerToken,
  roster,
  refresh,
}: {
  ownerToken: string;
  roster: MonitoringImport;
  refresh: () => void;
}) {
  const { scope, fileInput, upload, importRoster } = roster;
  return (
    <CardHeader className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4 sm:flex-row">
      <div>
        <CardTitle className="text-lg">
          <h2 id="monitoring-title">monitoring coverage</h2>
        </CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">
          Public checks, failures and missing coverage. Private and native workflows have separate
          limits.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {scope.role === 'owner' && !ownerToken ? (
          <>
            <input
              ref={fileInput}
              className="hidden"
              type="file"
              accept="application/json,.json"
              aria-label="Monitoring roster file"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void importRoster(file);
              }}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={upload.epoch === scope.epoch && upload.busy}
              onClick={() => fileInput.current?.click()}
            >
              load monitoring roster
            </Button>
          </>
        ) : null}
        <Button variant="outline" size="sm" onClick={refresh} aria-label="Refresh monitoring">
          <RefreshCw className="size-4" /> refresh
        </Button>
      </div>
    </CardHeader>
  );
}

function MonitoringRoster({ report }: { report: MonitoringReport }) {
  const healthy = report?.projects.filter((project) => project.state === 'healthy').length ?? 0;
  const failing =
    report?.projects.filter((project) => ['failing', 'degraded'].includes(project.state)).length ??
    0;
  return (
    <>
      <p className="text-sm">
        {report.projects.length} projects · {healthy} healthy · {failing} failing or slow
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {report.projects.length - healthy - failing} have missing, stale, offline or limited
        coverage. No errors does not establish health.
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Hosted checks run hourly. Expand a project for each location and its last check time.
      </p>
      {report.projects.length === 0 ? (
        <p className="mt-4 text-sm">Monitoring coverage is not configured for this workspace.</p>
      ) : (
        <ul aria-label="Project monitoring coverage" className="mt-4 divide-y border-t pt-3">
          {report.projects.map((project) => (
            <MonitoringProject key={project.catalog_id} project={project} />
          ))}
        </ul>
      )}
    </>
  );
}

function MonitoringBody({
  monitor,
  roster,
}: {
  monitor: ReturnType<typeof useMonitoringReport>;
  roster: MonitoringImport;
}) {
  const { current, report } = monitor;
  const { scope, upload } = roster;
  return (
    <CardContent className="p-5">
      {!current || current.loading ? <p role="status">Loading monitoring coverage…</p> : null}
      {current?.error ? (
        <p role="alert" className="text-sm text-destructive">
          {current.error}
        </p>
      ) : null}
      {upload.epoch === scope.epoch && upload.message ? (
        <p role="status" className="mb-3 text-sm">
          {upload.message}
        </p>
      ) : null}
      {report ? <MonitoringRoster report={report} /> : null}
    </CardContent>
  );
}

export function MonitoringCoverage({ ownerToken }: { ownerToken: string }) {
  const monitor = useMonitoringReport(ownerToken);
  const roster = useMonitoringImport(ownerToken, monitor.refresh);
  return (
    <Card className="gap-0 py-0 shadow-none" aria-labelledby="monitoring-title">
      <MonitoringHeader ownerToken={ownerToken} roster={roster} refresh={monitor.refresh} />
      <MonitoringBody monitor={monitor} roster={roster} />
    </Card>
  );
}
