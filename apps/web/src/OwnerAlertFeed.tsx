import { useEffect, useState } from 'react';
import { AlertTriangle, Mail, MessageSquareText, RefreshCw, UserRoundPlus } from 'lucide-react';
import { Button } from './components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card.js';
import { Skeleton } from './components/ui/skeleton.js';

interface AlertEntry {
  id: string;
  app_id: string;
  catalog_id: string;
  project_name: string;
  event: 'feedback.submitted' | 'waitlist.join' | 'newsletter.subscribe';
  timestamp: number;
}

interface Feed {
  generated_at: number;
  total_count: number;
  entries: AlertEntry[];
}

function eventLabel(event: AlertEntry['event']): string {
  if (event === 'feedback.submitted') return 'New feedback';
  if (event === 'waitlist.join') return 'Waitlist join';
  return 'Newsletter subscription';
}

function EventIcon({ event }: { event: AlertEntry['event'] }) {
  if (event === 'feedback.submitted')
    return <MessageSquareText aria-hidden="true" className="size-4" />;
  if (event === 'waitlist.join') return <UserRoundPlus aria-hidden="true" className="size-4" />;
  return <Mail aria-hidden="true" className="size-4" />;
}

function AlertEntries({ entries }: { entries: AlertEntry[] }): JSX.Element {
  return (
    <ol aria-label="Latest workspace alerts" className="divide-y">
      {entries.map((entry) => (
        <li key={entry.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
          <span className="rounded-md border bg-muted/40 p-2 text-muted-foreground">
            <EventIcon event={entry.event} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{eventLabel(entry.event)}</p>
            <p className="truncate text-xs text-muted-foreground">
              {entry.project_name} <span aria-hidden="true">·</span> {entry.catalog_id}
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
}: {
  loading: boolean;
  error: string;
  feed: Feed | null;
}): JSX.Element {
  if (loading)
    return (
      <div role="status" aria-label="Loading alerts" className="space-y-2">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  if (error)
    return (
      <div role="alert" className="flex items-start gap-2 text-sm text-destructive">
        <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" /> {error}
      </div>
    );
  if (!feed?.entries.length)
    return (
      <p className="text-sm text-muted-foreground">
        No retained response receipts are available in this feed.
      </p>
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
}): JSX.Element {
  return (
    <CardHeader className="flex-row items-center justify-between gap-4 border-b px-5 py-4">
      <div>
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
          Recent receipts
        </p>
        <CardTitle id="owner-alert-feed-title" className="mt-1 text-lg">
          Feedback and consented joins · separate from the selected day
        </CardTitle>
      </div>
      <div className="flex items-center gap-3">
        {!loading && feed && (
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {feed.total_count.toLocaleString()} in retention
          </span>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRefresh}
          aria-label="Refresh alerts"
          className="h-9"
        >
          <RefreshCw className="size-4" /> Refresh
        </Button>
      </div>
    </CardHeader>
  );
}

export function OwnerAlertFeed({ ownerToken }: { ownerToken: string }): JSX.Element {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void fetch('/v1/workspace/alerts', {
      signal: controller.signal,
      headers: ownerToken ? { authorization: `Bearer ${ownerToken}` } : {},
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Alerts returned ${response.status}`);
        return (await response.json()) as Feed;
      })
      .then((next) => {
        if (!controller.signal.aborted) setFeed(next);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Alerts are unavailable');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
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
      <CardContent className="p-5">
        <AlertBody loading={loading} error={error} feed={feed} />
        {feed && feed.total_count > feed.entries.length && !loading && !error && (
          <p className="mt-4 border-t pt-3 text-xs text-muted-foreground">
            Showing the latest {feed.entries.length} of {feed.total_count.toLocaleString()} retained
            alerts.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
