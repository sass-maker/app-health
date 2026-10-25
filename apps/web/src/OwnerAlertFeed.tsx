import { ownerFetch } from './lib/owner-fetch.js';
import { useEffect, useState, type ReactElement } from 'react';
import type { LogLevel, LogSource } from '@app-health/contracts';
import {
  AlertTriangle,
  CheckCircle2,
  Mail,
  MessageSquareText,
  RadioTower,
  RefreshCw,
  UserRoundPlus,
} from 'lucide-react';
import { Badge } from '@saas-maker/ui/components/badge';
import { Button } from '@saas-maker/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@saas-maker/ui/components/card';
import { QuoteListSkeleton } from '@saas-maker/ui/blocks/skeletons';
import { EmptyState } from '@saas-maker/ui/components/empty-state';
import { ErrorState } from '@saas-maker/ui/components/error-state';

const ALERT_FEED_TIMEOUT_MS = 10_000;

interface AlertEntry {
  id: string;
  app_id: string;
  catalog_id: string;
  project_name: string;
  event: string;
  level: LogLevel;
  source: LogSource;
  timestamp: number;
  journey?: string;
  location?: string;
}

interface ProbeCoverage {
  location: string;
  last_seen_at: number;
  interval_seconds: number;
  state: 'fresh' | 'stale';
}

interface Feed {
  generated_at: number;
  total_count: number;
  entries: AlertEntry[];
  probes?: ProbeCoverage[];
}

// Keep account data in memory only. A changed transport gets its own cache.
const feedCaches = new WeakMap<typeof fetch, Map<string, { feed: Feed; receivedAt: number }>>();
function cachedFeed(ownerToken: string): Feed | null {
  const entry = feedCaches.get(fetch)?.get(ownerToken);
  return entry && Date.now() - entry.receivedAt < 300_000 ? entry.feed : null;
}
function retainFeed(ownerToken: string, feed: Feed): void {
  let cache = feedCaches.get(fetch);
  if (!cache) {
    cache = new Map();
    feedCaches.set(fetch, cache);
  }
  cache.set(ownerToken, { feed, receivedAt: Date.now() });
}

const JOURNEY_LABELS: Record<string, string> = {
  'journey.failed': 'journey failing',
  'journey.degraded': 'journey slow',
  'journey.recovered': 'journey recovered',
};

function eventLabel(entry: AlertEntry): string {
  const journey = JOURNEY_LABELS[entry.event];
  if (journey) return journey;
  if (entry.event === 'feedback.submitted') return 'new feedback';
  if (entry.event === 'waitlist.join') return 'waitlist join';
  if (entry.event === 'newsletter.subscribe') return 'newsletter subscription';
  return entry.level === 'error' ? 'production failure' : 'service degraded';
}

function EventIcon({ event }: { event: AlertEntry['event'] }) {
  if (event === 'feedback.submitted')
    return <MessageSquareText aria-hidden="true" className="size-4" />;
  if (event === 'waitlist.join') return <UserRoundPlus aria-hidden="true" className="size-4" />;
  if (event === 'newsletter.subscribe') return <Mail aria-hidden="true" className="size-4" />;
  if (event === 'journey.recovered') return <CheckCircle2 aria-hidden="true" className="size-4" />;
  return <AlertTriangle aria-hidden="true" className="size-4" />;
}

function AlertEntries({ entries }: { entries: AlertEntry[] }): ReactElement {
  return (
    <ol aria-label="Latest workspace alerts" className="divide-y">
      {entries.map((entry) => (
        <li key={entry.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
          <span className="rounded-md border bg-muted/40 p-2 text-muted-foreground">
            <EventIcon event={entry.event} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{eventLabel(entry)}</p>
            <p className="truncate text-xs text-muted-foreground">
              {entry.project_name} <span aria-hidden="true">·</span> {entry.catalog_id}
              {entry.journey && entry.location ? (
                <>
                  {' '}
                  <span aria-hidden="true">·</span> {entry.journey} from {entry.location}{' '}
                  (synthetic)
                </>
              ) : (
                (entry.level === 'error' || entry.level === 'warn') && (
                  <>
                    {' '}
                    <span aria-hidden="true">·</span> {entry.source} {entry.event}
                  </>
                )
              )}
            </p>
          </div>
          <time
            className="shrink-0 text-xs text-muted-foreground"
            dateTime={new Date(entry.timestamp).toISOString()}
          >
            {new Date(entry.timestamp).toLocaleString()}
          </time>
        </li>
      ))}
    </ol>
  );
}

function AlertBody({
  loading,
  error,
  feed,
  onRetry,
}: {
  loading: boolean;
  onRetry: () => void;
  error: string;
  feed: Feed | null;
}): ReactElement {
  if (loading && !feed)
    return (
      <div role="status" aria-label="Loading alerts">
        <QuoteListSkeleton rows={2} lines={1} announce={false} />
      </div>
    );
  if (error)
    return <ErrorState title="alerts are unavailable" description={error} onRetry={onRetry} />;
  if (!feed?.entries.length)
    return (
      <EmptyState title="no retained production alerts or response receipts are available in this feed." />
    );
  return <AlertEntries entries={feed.entries} />;
}

function AlertHeader({
  feed,
  loading,
  onRefresh,
}: {
  feed: Feed | null;
  loading: boolean;
  onRefresh: () => void;
}): ReactElement {
  return (
    <CardHeader className="flex flex-col items-start justify-between gap-4 border-b px-5 py-4 sm:flex-row sm:items-center">
      <div>
        <p className="text-xs font-medium tracking-[0.16em] text-muted-foreground">recent alerts</p>
        <CardTitle id="owner-alert-feed-title" className="mt-1 text-lg">
          production failures and responses · separate from the selected day
        </CardTitle>
      </div>
      <div className="flex items-center gap-3">
        <span className="w-24 shrink-0 text-xs text-muted-foreground" aria-live="polite">
          {!loading && feed ? `${feed.total_count.toLocaleString()} in retention` : '\u00a0'}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRefresh}
          aria-label="Refresh alerts"
          className="h-9"
        >
          <RefreshCw className="size-4" /> refresh
        </Button>
      </div>
    </CardHeader>
  );
}

function elapsed(from: number, to: number): string {
  const minutes = Math.max(0, Math.round((to - from) / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

function ProbeCoverageLine({ feed }: { feed: Feed }): ReactElement | null {
  if (!feed.probes) return null;
  return (
    <div
      aria-label="Synthetic journey probes"
      className="mb-4 flex flex-wrap items-center gap-2 border-b pb-3 text-xs text-muted-foreground"
    >
      <RadioTower aria-hidden="true" className="size-4" />
      {feed.probes.length === 0 ? (
        <span>no synthetic journey probe has reported. journey coverage is missing.</span>
      ) : (
        feed.probes.map((probe) => (
          <span key={probe.location} className="flex items-center gap-1.5">
            {probe.location}
            <Badge variant={probe.state === 'stale' ? 'destructive' : 'secondary'}>
              {probe.state === 'stale' ? 'stale' : 'reporting'}
            </Badge>
            last run {elapsed(probe.last_seen_at, feed.generated_at)}
          </span>
        ))
      )}
    </div>
  );
}

export function OwnerAlertFeed({ ownerToken }: { ownerToken: string }): ReactElement {
  const [feed, setFeed] = useState<Feed | null>(() => cachedFeed(ownerToken));
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let timedOut = false;
    setFeed(cachedFeed(ownerToken));
    setLoading(true);
    setError('');
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
      if (!disposed) {
        setError('alerts request timed out after 10 seconds. try again.');
        setLoading(false);
      }
    }, ALERT_FEED_TIMEOUT_MS);
    void ownerFetch('/v1/workspace/alerts', ownerToken, {
      signal: controller.signal,
      headers: ownerToken ? { authorization: `Bearer ${ownerToken}` } : {},
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`alerts returned ${response.status}`);
        return (await response.json()) as Feed;
      })
      .then((next) => {
        if (!disposed && !timedOut) {
          retainFeed(ownerToken, next);
          setFeed(next);
        }
      })
      .catch((cause: unknown) => {
        if (!disposed && !timedOut)
          setError(cause instanceof Error ? cause.message : 'alerts are unavailable');
      })
      .finally(() => {
        window.clearTimeout(timeout);
        if (!disposed && !timedOut) setLoading(false);
      });
    return () => {
      disposed = true;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [ownerToken, retry]);

  useEffect(() => {
    const refresh = () => setRetry((value) => value + 1);
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  return (
    <Card
      id="owner-alert-feed"
      aria-labelledby="owner-alert-feed-title"
      className="gap-0 py-0 shadow-none"
    >
      <AlertHeader feed={feed} loading={loading} onRefresh={() => setRetry((value) => value + 1)} />
      <CardContent className="min-h-72 p-5">
        {feed && !loading && !error && <ProbeCoverageLine feed={feed} />}
        <AlertBody
          loading={loading}
          error={error}
          feed={feed}
          onRetry={() => setRetry((value) => value + 1)}
        />
        {feed && feed.total_count > feed.entries.length && !loading && !error && (
          <p className="mt-4 border-t pt-3 text-xs text-muted-foreground">
            showing the latest {feed.entries.length} of {feed.total_count.toLocaleString()} retained
            alerts.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
