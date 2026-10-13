import { AnalyticsReportLoading } from './AnalyticsReportLoading.js';
import {
  parseSharedAnalytics,
  type SharedAnalytics as PublicAnalytics,
} from '@app-health/contracts/sharing';
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { usePublicAnalytics } from './usePublicAnalytics.js';
import { PublicAnalyticsReport } from './PublicAnalyticsReport.js';
import { Badge } from '@saas-maker/ui/components/badge';
import { ErrorState } from '@saas-maker/ui/components/error-state';

const TOKEN_PATTERN = /^ahs_[A-Za-z0-9_-]{43}$/;

function tokenFromLocation(): string | null {
  const value = new URLSearchParams(window.location.hash.slice(1)).get('token');
  return value && TOKEN_PATTERN.test(value) ? value : null;
}

function PublicHeader({ data, embed }: { data: PublicAnalytics | null; embed: boolean }) {
  return (
    <header className="mb-5 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-xs font-medium text-muted-foreground">live analytics · App Health</p>
        <h1
          className={
            embed
              ? 'mt-2 break-words text-xl font-semibold tracking-tight'
              : 'mt-2 break-words text-3xl font-semibold tracking-tight'
          }
        >
          {data?.project.name ?? 'public analytics'}
        </h1>
        {data ? (
          <Badge variant="secondary" className="mt-2">
            {data.project.environment}
          </Badge>
        ) : null}
      </div>
      {!embed ? (
        <a
          className="shrink-0 text-sm text-muted-foreground underline-offset-4 hover:underline"
          href="/"
          rel="noreferrer"
        >
          about App Health
        </a>
      ) : null}
    </header>
  );
}
function PublicUnavailable({ reason, retry }: { reason: 'link' | 'temporary'; retry: () => void }) {
  return (
    <ErrorState
      title={
        reason === 'link'
          ? 'this analytics link is unavailable'
          : 'analytics are temporarily unavailable'
      }
      description={
        reason === 'link'
          ? 'the owner may have revoked this link.'
          : 'the latest live count was cleared. we will try again shortly.'
      }
      onRetry={retry}
      className="rounded-lg border border-dashed bg-card"
    />
  );
}
export function PublicAnalyticsView(): ReactElement {
  const [token, setToken] = useState(tokenFromLocation);
  useEffect(() => {
    const change = () => setToken(tokenFromLocation());
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  const embed = useMemo(() => new URLSearchParams(window.location.search).get('embed') === '1', []);
  const { state, retry } = usePublicAnalytics(token, parseSharedAnalytics);
  const data = state.kind === 'ready' ? state.data : null;
  return (
    <main
      className={
        embed
          ? 'min-h-[360px] w-full min-w-0 bg-background p-4 text-foreground'
          : 'min-h-screen bg-background px-4 py-8 text-foreground sm:px-6 lg:py-12'
      }
      data-embed={embed ? 'true' : 'false'}
    >
      <div className={embed ? 'mx-auto max-w-3xl' : 'mx-auto max-w-5xl'}>
        <PublicHeader data={data} embed={embed} />
        {state.kind === 'unavailable' ? (
          <PublicUnavailable reason={state.reason} retry={retry} />
        ) : null}
        {state.kind === 'loading' ? (
          <AnalyticsReportLoading label="Loading shared analytics" />
        ) : null}
        {state.kind === 'ready' ? (
          <PublicAnalyticsReport
            data={state.data}
            embed={embed}
            stale={state.stale ?? false}
            refreshing={state.refreshing ?? false}
            retry={retry}
          />
        ) : null}
      </div>
    </main>
  );
}
