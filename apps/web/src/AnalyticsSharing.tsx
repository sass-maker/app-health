import { SkeletonText } from '@saas-maker/ui/components/skeleton';
import { ErrorState } from '@saas-maker/ui/components/error-state';
import { EmptyState } from '@saas-maker/ui/components/empty-state';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Copy, ExternalLink, Link2 } from 'lucide-react';
import type { AnalyticsShare } from '@app-health/contracts';
import { Button } from '@saas-maker/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@saas-maker/ui/components/card';
import { Input } from '@saas-maker/ui/components/input';
import { Badge } from '@saas-maker/ui/components/badge';

interface Project {
  appId: string;
  environmentId: string;
  name: string;
  environment: string;
}
function endpoint(project: Project): string {
  return `/v1/analytics/shares?${new URLSearchParams({ app_id: project.appId, environment_id: project.environmentId })}`;
}
async function shareRequest(
  url: string,
  ownerToken: string,
  method = 'GET',
  payload?: Record<string, boolean>,
): Promise<{ shares?: AnalyticsShare[]; share?: AnalyticsShare; token?: string }> {
  const headers: Record<string, string> = ownerToken
    ? { authorization: `Bearer ${ownerToken}` }
    : {};
  if (payload) headers['content-type'] = 'application/json';
  const response = await fetch(url, {
    method,
    headers,
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const body = (await response.json()) as {
    error?: string;
    shares?: AnalyticsShare[];
    share?: AnalyticsShare;
    token?: string;
  };
  if (!response.ok) throw new Error(body.error ?? 'sharing is temporarily unavailable.');
  return body;
}
function ShareCode({ token, project }: { token: string; project: Project }) {
  const [status, setStatus] = useState('');
  const link = `${location.origin}/live#token=${token}`;
  const embed = `<iframe src="${location.origin}/live?embed=1#token=${token}" title="${project.name.replace(/["<>]/g, '')} live analytics" width="100%" height="640" style="border:0;border-radius:12px" loading="lazy" referrerpolicy="no-referrer"></iframe>`;
  async function copy(value: string, fieldId: string) {
    try {
      await navigator.clipboard.writeText(value);
      setStatus('copied to clipboard.');
    } catch {
      setStatus('copy was unavailable. the field is selected so you can copy it.');
      document.getElementById(fieldId)?.focus();
    }
  }
  return (
    <div className="space-y-4 rounded-lg border bg-muted/30 p-4">
      <p className="text-sm font-medium">your public link is ready</p>
      <p className="text-xs text-muted-foreground">
        copy it now. the full link is shown only once. anyone with it can see this environment’s
        live sessions and traffic until you revoke it.
      </p>
      <div className="space-y-2">
        <label htmlFor="analytics-share-link" className="text-sm font-medium">
          public page
        </label>
        <Input
          id="analytics-share-link"
          readOnly
          value={link}
          onFocus={(event) => event.currentTarget.select()}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-0"
            onClick={() => void copy(link, 'analytics-share-link')}
          >
            <Copy />
            copy public link
          </Button>
          <Button variant="ghost" size="sm" className="min-h-11 sm:min-h-0" asChild>
            <a href={link} target="_blank" rel="noopener noreferrer">
              <ExternalLink />
              open public page
            </a>
          </Button>
        </div>
      </div>
      <div className="space-y-2">
        <label htmlFor="analytics-share-embed" className="text-sm font-medium">
          embed on your product
        </label>
        <textarea
          id="analytics-share-embed"
          className="min-h-24 w-full resize-y rounded-md border border-input bg-background p-3 font-mono text-xs"
          readOnly
          value={embed}
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-0"
          onClick={() => void copy(embed, 'analytics-share-embed')}
        >
          <Copy />
          copy embed code
        </Button>
      </div>
      <p role="status" className="text-xs text-muted-foreground">
        {status}
      </p>
    </div>
  );
}
export function AnalyticsSharing({
  project,
  ownerToken,
}: {
  project: Project;
  ownerToken: string;
}): ReactElement {
  const [shares, setShares] = useState<AnalyticsShare[]>([]);
  const [created, setCreated] = useState<{ id: string; token: string } | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [includeBreakdowns, setIncludeBreakdowns] = useState(false);
  const [revision, setRevision] = useState(0);
  const scope = `${project.appId}/${project.environmentId}/${ownerToken}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  useEffect(() => {
    let cancelled = false;
    setShares([]);
    setCreated(null);
    setError('');
    setLoading(true);
    setIncludeBreakdowns(false);
    const requestScope = scope;
    void shareRequest(endpoint(project), ownerToken)
      .then((body) => {
        if (!cancelled && scopeRef.current === requestScope) setShares(body.shares ?? []);
      })
      .catch((cause) => {
        if (!cancelled && scopeRef.current === requestScope)
          setError(cause instanceof Error ? cause.message : 'sharing is unavailable.');
      })
      .finally(() => {
        if (!cancelled && scopeRef.current === requestScope) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project.appId, project.environmentId, ownerToken, revision, scope]);
  async function create() {
    const requestScope = scope;
    setPending(true);
    setError('');
    try {
      const body = await shareRequest(endpoint(project), ownerToken, 'POST', {
        include_breakdowns: includeBreakdowns,
      });
      if (!body.share || !body.token || !/^ahs_[A-Za-z0-9_-]{43}$/.test(body.token))
        throw new Error(
          'the public link could not be read. refresh the link list before retrying.',
        );
      if (scopeRef.current !== requestScope) return;
      setCreated({ id: body.share.id, token: body.token });
      setShares((current) => [body.share!, ...current]);
    } catch (cause) {
      if (scopeRef.current === requestScope)
        setError(cause instanceof Error ? cause.message : 'could not create a link.');
    } finally {
      if (scopeRef.current === requestScope) setPending(false);
    }
  }
  async function revoke(id: string) {
    const requestScope = scope;
    setPending(true);
    setError('');
    try {
      await shareRequest(`${endpoint(project)}&id=${encodeURIComponent(id)}`, ownerToken, 'DELETE');
      if (scopeRef.current !== requestScope) return;
      setShares((current) =>
        current.map((share) => (share.id === id ? { ...share, revoked_at: Date.now() } : share)),
      );
      if (created?.id === id) setCreated(null);
    } catch (cause) {
      if (scopeRef.current === requestScope)
        setError(cause instanceof Error ? cause.message : 'could not revoke the link.');
    } finally {
      if (scopeRef.current === requestScope) setPending(false);
    }
  }
  async function updateBreakdowns(id: string, value: boolean) {
    const requestScope = scope;
    setPending(true);
    setError('');
    try {
      await shareRequest(`${endpoint(project)}&id=${encodeURIComponent(id)}`, ownerToken, 'PATCH', {
        include_breakdowns: value,
      });
      if (scopeRef.current !== requestScope) return;
      setShares((current) =>
        current.map((share) => (share.id === id ? { ...share, include_breakdowns: value } : share)),
      );
    } catch (cause) {
      if (scopeRef.current === requestScope)
        setError(cause instanceof Error ? cause.message : 'could not update the public link.');
    } finally {
      if (scopeRef.current === requestScope) setPending(false);
    }
  }
  return (
    <Card className="shadow-none" id="public-analytics-sharing">
      <CardHeader>
        <CardTitle>public live analytics</CardTitle>
        <CardDescription>
          Let visitors see {project.name}’s live sessions and 24-hour traffic on your website. This
          shares {project.environment} only. Logs, keys, event names and other projects stay
          private. You can optionally share aggregate sessions, event totals, top routes and
          referrer hosts.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm">
          <input
            id="analytics-share-breakdowns-create"
            type="checkbox"
            checked={includeBreakdowns}
            onChange={(event) => setIncludeBreakdowns(event.currentTarget.checked)}
            disabled={pending || loading}
            className="mt-0.5 size-4 accent-primary"
          />
          <span>
            <span className="font-medium">share top routes, sources and countries</span>
            <span className="mt-1 block text-xs text-muted-foreground">
              includes aggregate sessions, event totals, top routes and referrer hosts. event names,
              logs, keys and identities stay private.
            </span>
          </span>
        </label>
        <Button
          disabled={
            pending || loading || shares.filter((share) => share.revoked_at === null).length >= 5
          }
          onClick={() => void create()}
        >
          <Link2 />
          create public link
        </Button>
        {loading ? (
          <SkeletonText
            aria-label="Loading share links"
            lines={3}
            className="rounded-lg border p-4"
          />
        ) : null}
        {error ? (
          <ErrorState
            title="sharing is unavailable"
            description={error}
            primaryAction={{
              label: 'refresh links',
              onClick: () => setRevision((value) => value + 1),
            }}
          />
        ) : null}
        {created ? <ShareCode token={created.token} project={project} /> : null}
        <ul className="divide-y rounded-lg border">
          {shares.map((share) => (
            <li key={share.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">link {share.id.slice(0, 8)}</p>
                <p className="text-xs text-muted-foreground">
                  created {new Date(share.created_at).toLocaleString()}
                </p>
              </div>
              {share.revoked_at === null ? (
                <div className="flex flex-wrap items-center gap-2">
                  <label
                    htmlFor={`analytics-share-breakdowns-${share.id}`}
                    className="flex items-center gap-2 text-xs text-muted-foreground"
                  >
                    <input
                      id={`analytics-share-breakdowns-${share.id}`}
                      type="checkbox"
                      checked={share.include_breakdowns === true}
                      onChange={(event) =>
                        void updateBreakdowns(share.id, event.currentTarget.checked)
                      }
                      disabled={pending}
                    />
                    routes and sources
                  </label>
                  <Button
                    variant="outline"
                    size="sm"
                    className="min-h-11 sm:min-h-0"
                    disabled={pending}
                    aria-label={`Revoke link ${share.id.slice(0, 8)}`}
                    onClick={() => void revoke(share.id)}
                  >
                    revoke
                  </Button>
                </div>
              ) : (
                <Badge variant="secondary">revoked</Badge>
              )}
            </li>
          ))}
        </ul>
        {!error && !loading && !shares.length ? (
          <EmptyState
            title="no public links yet."
            description="sharing is off until you create one."
            className="py-6"
          />
        ) : null}
        <p className="text-xs text-muted-foreground">
          Up to five active links per environment. Revocation blocks new reads immediately; open
          panels update within their next 10-second refresh. Previously copied data cannot be
          recalled.
        </p>
      </CardContent>
    </Card>
  );
}
