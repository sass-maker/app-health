import type { ReactElement } from 'react';
import { ArrowUpRight, ChevronDown, Database, Unplug } from 'lucide-react';
import { Badge } from '@saas-maker/ui/components/badge';
import type { OperationsFeed, OperationsSnapshot } from './lib/operations-model.js';

export function dateLabel(value: string | null): string {
  return value
    ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : 'not available';
}
function HealthBadge({ feed }: { feed: OperationsFeed }): ReactElement {
  const critical = feed.health === 'failing' || feed.health === 'unavailable';
  return (
    <span className="flex flex-wrap gap-1.5">
      <Badge variant={critical ? 'destructive' : 'secondary'}>
        {feed.health === 'healthy' ? 'check passed' : feed.health}
      </Badge>
      <Badge variant="outline">
        {feed.freshness === 'current' ? 'current collection' : `${feed.freshness} evidence`}
      </Badge>
    </span>
  );
}
export function EvidenceLink({ url }: { url?: string }): ReactElement | null {
  return url ? (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex min-h-9 items-center gap-1 text-xs underline underline-offset-4"
    >
      source evidence <ArrowUpRight aria-hidden="true" className="size-3" />
    </a>
  ) : null;
}
function FeedRow({ feed }: { feed: OperationsFeed }): ReactElement {
  return (
    <li className="space-y-3 border-t py-4 first:border-t-0">
      <div className="flex flex-col justify-between gap-2 md:flex-row">
        <h4 className="min-w-0 break-words text-sm font-medium">{feed.name}</h4>
        <HealthBadge feed={feed} />
      </div>
      <p className="break-words text-sm leading-relaxed text-muted-foreground">{feed.summary}</p>
      <dl className="grid gap-x-6 gap-y-2 text-xs text-muted-foreground sm:grid-cols-2">
        <div>
          <dt className="font-medium text-foreground">Collected</dt>
          <dd>{dateLabel(feed.collectedAt)}</dd>
        </div>
        <div>
          <dt className="font-medium text-foreground">Source observation</dt>
          <dd>{dateLabel(feed.observedAt)}</dd>
        </div>
      </dl>
      <p className="break-words text-xs leading-relaxed text-muted-foreground">
        {feed.limitations}
      </p>
      <EvidenceLink url={feed.evidenceUrl} />
    </li>
  );
}
export function SourceInventory({
  snapshot,
  feeds,
  familyId,
}: {
  snapshot: OperationsSnapshot;
  feeds: OperationsFeed[];
  familyId: string;
}): ReactElement {
  return (
    <div className="space-y-3" aria-label="Source inventory">
      {snapshot.families
        .filter((family) => familyId === 'all' || family.id === familyId)
        .map((family) => {
          const matching = feeds.filter((feed) => feed.familyId === family.id);
          const available = matching.filter((feed) => feed.health !== 'unavailable').length;
          const unavailable = matching.length - available;
          const stale = matching.filter((feed) => feed.freshness !== 'current').length;
          return (
            <details key={family.id} className="group rounded-lg border bg-card px-4 sm:px-5">
              <summary className="flex min-h-24 cursor-pointer list-none flex-wrap items-center gap-3 py-4 [&::-webkit-details-marker]:hidden">
                <span className="rounded-md border p-2 text-muted-foreground">
                  {available ? (
                    <Database className="size-4" aria-hidden="true" />
                  ) : (
                    <Unplug className="size-4" aria-hidden="true" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{family.name}</span>
                  <span className="mt-1 block break-words text-xs text-muted-foreground">
                    Produced by {family.producer}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant={available ? 'secondary' : 'outline'}>
                    {available
                      ? `${available} observed feeds`
                      : unavailable
                        ? 'unavailable'
                        : 'not connected in scope'}
                  </Badge>
                  {unavailable ? <span>{unavailable} unavailable</span> : null}
                  {stale ? <span>{stale} stale or missing</span> : null}
                  <ChevronDown
                    className="size-4 transition-transform group-open:rotate-180"
                    aria-hidden="true"
                  />
                </span>
              </summary>
              <div className="border-t pb-2 pt-4">
                <p className="text-xs text-muted-foreground">Collected by {family.collector}</p>
                <p className="my-3 text-sm leading-relaxed text-muted-foreground">
                  {family.limitations}
                </p>
                {matching.length ? (
                  <ul>
                    {matching.map((feed) => (
                      <FeedRow key={feed.id} feed={feed} />
                    ))}
                  </ul>
                ) : (
                  <p className="pb-4 text-sm text-muted-foreground">
                    No observed feed is connected for this source in the selected scope.
                  </p>
                )}
              </div>
            </details>
          );
        })}
    </div>
  );
}
