import { useEffect, useState } from 'react';
import { Copy, ExternalLink, Link2 } from 'lucide-react';
import type { AnalyticsShare } from '@app-health/contracts';
import { Button } from './components/ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card.js';
import { Input } from './components/ui/input.js';
import { Badge } from './components/ui/badge.js';

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
): Promise<{ shares?: AnalyticsShare[]; share?: AnalyticsShare; token?: string }> {
  const response = await fetch(url, {
    method,
    headers: ownerToken ? { authorization: `Bearer ${ownerToken}` } : {},
  });
  const body = (await response.json()) as {
    error?: string;
    shares?: AnalyticsShare[];
    share?: AnalyticsShare;
    token?: string;
  };
  if (!response.ok) throw new Error(body.error ?? 'Sharing is temporarily unavailable.');
  return body;
}
function ShareCode({ token, project }: { token: string; project: Project }) {
  const [status, setStatus] = useState('');
  const link = `${location.origin}/live#token=${token}`;
  const embed = `<iframe src="${location.origin}/live?embed=1#token=${token}" title="${project.name.replace(/["<>]/g, '')} live analytics" width="100%" height="640" style="border:0;border-radius:12px" loading="lazy" referrerpolicy="no-referrer"></iframe>`;
  async function copy(value: string, fieldId: string) {
    try {
      await navigator.clipboard.writeText(value);
      setStatus('Copied to clipboard.');
    } catch {
      setStatus('Copy was unavailable. The field is selected so you can copy it.');
      document.getElementById(fieldId)?.focus();
    }
  }
  return (
    <div className="space-y-4 rounded-lg border bg-muted/30 p-4">
      <p className="text-sm font-medium">Your public link is ready</p>
      <p className="text-xs text-muted-foreground">
        Copy it now. The full link is shown only once. Anyone with it can see this environment’s
        live sessions and traffic until you revoke it.
      </p>
      <div className="space-y-2">
        <label htmlFor="analytics-share-link" className="text-sm font-medium">
          Public page
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
            Copy public link
          </Button>
          <Button variant="ghost" size="sm" className="min-h-11 sm:min-h-0" asChild>
            <a href={link} target="_blank" rel="noopener noreferrer">
              <ExternalLink />
              Open public page
            </a>
          </Button>
        </div>
      </div>
      <div className="space-y-2">
        <label htmlFor="analytics-share-embed" className="text-sm font-medium">
          Embed on your product
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
          Copy embed code
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
}): JSX.Element {
  const [shares, setShares] = useState<AnalyticsShare[]>([]);
  const [created, setCreated] = useState<{ id: string; token: string } | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setShares([]);
    setCreated(null);
    setError('');
    setLoading(true);
    void shareRequest(endpoint(project), ownerToken)
      .then((body) => {
        if (!cancelled) setShares(body.shares ?? []);
      })
      .catch((cause) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : 'Sharing is unavailable.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project.appId, project.environmentId, ownerToken, revision]);
  async function create() {
    setPending(true);
    setError('');
    try {
      const body = await shareRequest(endpoint(project), ownerToken, 'POST');
      if (!body.share || !body.token || !/^ahs_[A-Za-z0-9_-]{43}$/.test(body.token))
        throw new Error(
          'The public link could not be read. Refresh the link list before retrying.',
        );
      setCreated({ id: body.share.id, token: body.token });
      setShares((current) => [body.share!, ...current]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create a link.');
    } finally {
      setPending(false);
    }
  }
  async function revoke(id: string) {
    setPending(true);
    setError('');
    try {
      await shareRequest(`${endpoint(project)}&id=${encodeURIComponent(id)}`, ownerToken, 'DELETE');
      setShares((current) =>
        current.map((share) => (share.id === id ? { ...share, revoked_at: Date.now() } : share)),
      );
      if (created?.id === id) setCreated(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not revoke the link.');
    } finally {
      setPending(false);
    }
  }
  return (
    <Card className="shadow-none" id="public-analytics-sharing">
      <CardHeader>
        <CardTitle>Public live analytics</CardTitle>
        <CardDescription>
          Let visitors see {project.name}’s live sessions and 24-hour traffic on your website. This
          shares {project.environment} only. Logs, keys, event names and other projects stay
          private.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button
          disabled={
            pending || loading || shares.filter((share) => share.revoked_at === null).length >= 5
          }
          onClick={() => void create()}
        >
          <Link2 />
          Create public link
        </Button>
        {loading ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading share links…
          </p>
        ) : null}
        {error ? (
          <div role="alert" className="space-y-2 text-sm text-destructive">
            <p>{error}</p>
            <Button
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-0"
              onClick={() => setRevision((value) => value + 1)}
            >
              Refresh links
            </Button>
          </div>
        ) : null}
        {created ? <ShareCode token={created.token} project={project} /> : null}
        <ul className="divide-y rounded-lg border">
          {shares.map((share) => (
            <li key={share.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">Link {share.id.slice(0, 8)}</p>
                <p className="text-xs text-muted-foreground">
                  Created {new Date(share.created_at).toLocaleString()}
                </p>
              </div>
              {share.revoked_at === null ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="min-h-11 sm:min-h-0"
                  disabled={pending}
                  aria-label={`Revoke link ${share.id.slice(0, 8)}`}
                  onClick={() => void revoke(share.id)}
                >
                  Revoke
                </Button>
              ) : (
                <Badge variant="secondary">Revoked</Badge>
              )}
            </li>
          ))}
        </ul>
        {!error && !loading && !shares.length ? (
          <p className="text-sm text-muted-foreground">
            No public links yet. Sharing is off until you create one.
          </p>
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
