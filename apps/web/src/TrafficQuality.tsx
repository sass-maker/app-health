import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  TrafficQuality as TrafficQualitySchema,
  type BrowserReport,
  type TrafficQuality as Report,
} from '@app-health/contracts';
import { Card, CardContent, CardHeader, CardTitle } from '@saas-maker/ui/components/card';
import { Badge } from '@saas-maker/ui/components/badge';
import { Button } from '@saas-maker/ui/components/button';
import { ownerFetch } from './lib/owner-fetch.js';
import { useWorkspaceScope, workspaceScope } from './lib/workspace-scope.js';

type State = { key: string } & (
  | { status: 'waiting' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; report: Report }
);
interface Props {
  ownerToken: string;
  appId: string;
  environmentId: string;
  report: BrowserReport | null;
  filtered: boolean;
}

function useTrafficQuality(props: Props) {
  const workspace = useWorkspaceScope();
  const { ownerToken, appId, environmentId, filtered } = props;
  const identity = JSON.stringify([
    ownerToken,
    workspace.id,
    workspace.epoch,
    appId,
    environmentId,
  ]);
  const context = useRef({ report: props.report, identity });
  if (context.current.report !== props.report) context.current = { report: props.report, identity };
  const report = context.current.identity === identity ? props.report : null;
  const from = report?.from;
  const to = report?.to;
  const key = JSON.stringify([identity, from, to, filtered]);
  const [state, setState] = useState<State>({ key, status: 'loading' });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (filtered || from === undefined || to === undefined) return;
    const controller = new AbortController();
    let cancelled = false;
    const timer = setTimeout(() => controller.abort(), 12_000);
    const current = () => !cancelled && workspaceScope().epoch === workspace.epoch;
    setState({ key, status: 'loading' });
    async function load() {
      try {
        const params = new URLSearchParams({
          app_id: appId,
          environment_id: environmentId,
          from: String(from),
          to: String(to),
        });
        const response = await ownerFetch(`/v1/analytics/traffic-quality?${params}`, ownerToken, {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('Traffic quality unavailable');
        const parsed = TrafficQualitySchema.parse(await response.json());
        if (
          parsed.app_id !== appId ||
          parsed.environment_id !== environmentId ||
          parsed.from !== from ||
          parsed.to !== to
        )
          throw new Error('Traffic quality scope mismatch');
        if (current() && !controller.signal.aborted)
          setState({ key, status: 'ready', report: parsed });
      } catch {
        if (current()) setState({ key, status: 'error' });
      } finally {
        clearTimeout(timer);
      }
    }
    void load();
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [key, retry, ownerToken, appId, environmentId, from, to, filtered, workspace.epoch]);
  return {
    report,
    state: !report
      ? { key, status: 'waiting' as const }
      : state.key === key
        ? state
        : { key, status: 'loading' as const },
    retry: () => setRetry((value) => value + 1),
  };
}

const count = (value: number) => value.toLocaleString();
const unknownReason = {
  local: 'Bot counters are unavailable in local development.',
  unavailable: 'Bot counters are temporarily unavailable.',
  no_records: 'No retained bot records establish coverage for this period.',
  invalid_response: 'Bot counters could not be validated.',
  index_too_long: 'Bot counters do not support this project identifier.',
};

function BotReading({ state, retry }: ReturnType<typeof useTrafficQuality>): ReactElement {
  if (state.status === 'waiting')
    return (
      <p className="text-sm text-muted-foreground">
        Load the analytics report to view bot counters for its period.
      </p>
    );
  if (state.status === 'loading')
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading bot counters…
      </p>
    );
  if (state.status === 'error')
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">Bot counters could not load.</p>
        <Button size="sm" variant="outline" onClick={retry}>
          Retry traffic quality
        </Button>
      </div>
    );
  const bots = state.report.bots;
  if (bots.status === 'unknown')
    return (
      <div className="space-y-2">
        <p className="text-2xl font-semibold">Unknown</p>
        <p className="text-xs text-muted-foreground">
          {unknownReason[bots.reason]} Unknown does not mean zero.
        </p>
        <Button size="sm" variant="outline" onClick={retry}>
          Retry traffic quality
        </Button>
      </div>
    );
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-2xl font-semibold tabular-nums">{count(bots.pageview_attempts)}</p>
        <Badge variant="secondary">
          {bots.estimated ? 'estimated · partial coverage' : 'partial coverage'}
        </Badge>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        Cloudflare verified: {count(bots.cloudflare_verified)} · Recognized user agent:{' '}
        {count(bots.recognized_user_agent)}
      </p>
      <p className="text-xs leading-5 text-muted-foreground">
        By receipt time. Retried batches may count again.
      </p>
    </div>
  );
}

export function TrafficQuality(props: Props): ReactElement {
  const reading = useTrafficQuality(props);
  const historical = !!reading.report && reading.report.from < Date.UTC(2026, 9, 1);
  const pageviews = reading.report?.series.reduce((sum, row) => sum + row.pageviews, 0);
  return (
    <Card aria-label="Traffic quality" className="gap-4">
      <CardHeader className="pb-0">
        <CardTitle className="text-base">Traffic quality</CardTitle>
        <p className="text-xs leading-5 text-muted-foreground">
          Browser observations only. Many crawlers never execute the tracker.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {props.filtered ? (
          <p className="text-sm text-muted-foreground">
            Traffic quality is unavailable for segment or named event filters. Clear filters to view
            pageview counts for this project.
          </p>
        ) : (
          <div className="grid gap-5 lg:grid-cols-2">
            <div className="space-y-2">
              <p className="text-sm font-medium">
                {historical ? 'Browser pageviews' : 'Not detected as bots'}
              </p>
              <p className="text-2xl font-semibold tabular-nums">
                {pageviews === undefined ? '—' : count(pageviews)}
              </p>
              <p className="text-xs leading-5 text-muted-foreground">
                {reading.report?.sampled ? 'Estimated pageviews' : 'Pageviews'} by event time.{' '}
                {historical
                  ? 'This period includes data before bot filtering began on October 1, 2026 and may include known bots.'
                  : 'These are not verified humans.'}
              </p>
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium">Recorded bot pageview attempts</p>
              <BotReading {...reading} />
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 border-t pt-3 text-xs">
          <span className="font-medium">QA / internal traffic</span>
          <Badge variant="outline">Not separately identified</Badge>
        </div>
        <details className="text-xs text-muted-foreground">
          <summary className="w-fit cursor-pointer font-medium">How these counts work</summary>
          <p className="mt-2 max-w-3xl leading-5">
            Known bots are excluded from browser reports. Unrecognized automation can remain. Bot
            counters have partial coverage and use a different clock, so these counts do not form a
            combined total or a bot percentage. appHealth.ignore excludes a browser before
            collection; those visits have no count here.
          </p>
        </details>
      </CardContent>
    </Card>
  );
}
