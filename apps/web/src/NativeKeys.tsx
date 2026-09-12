import { useEffect, useState } from 'react';
import { NativeKey } from '@app-health/contracts';
import { Button } from './components/ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card.js';
import { Input } from './components/ui/input.js';
import { Badge } from './components/ui/badge.js';

interface Props {
  project: { appId: string; environmentId: string };
  ownerToken: string;
  ingestOrigin: string;
}
async function nativeRequest(url: string, token: string, method: string, signal?: AbortSignal) {
  const response = await fetch(url, {
    method,
    signal: signal ?? AbortSignal.timeout(8000),
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? 'Native keys are unavailable.');
  return body;
}
function NativeKeyReveal({ value, origin }: { value: string; origin: string }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setCopyError('');
    } catch {
      setCopyError('Copy unavailable. Select the key above to copy it.');
    }
  }
  const snippet = `let health = try AppHealthClient(\n    endpoint: URL(string: "${origin}")!,\n    publicKey: "${value}"\n)\nawait health.track("onboarding.completed")`;
  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
      <p className="text-sm font-medium">Copy your native public key now</p>
      <Input
        aria-label="Native public key"
        readOnly
        value={value}
        onFocus={(event) => event.currentTarget.select()}
      />
      <Button variant="outline" size="sm" onClick={() => void copy()}>
        {copied ? 'Copied' : 'Copy native key'}
      </Button>
      {copyError ? (
        <p role="status" className="text-xs text-muted-foreground">
          {copyError}
        </p>
      ) : null}
      <pre className="overflow-x-auto rounded-md bg-zinc-950 p-4 text-xs leading-6 text-zinc-100">
        <code>{snippet}</code>
      </pre>
      <p className="text-xs text-muted-foreground">
        This key can be included in your app. It can send events and logs to this environment, but
        cannot read data or send server measurements.
      </p>
    </div>
  );
}
function parseNativeCreation(body: { record: unknown; key: unknown }) {
  const record = NativeKey.parse(body.record);
  if (typeof body.key !== 'string' || !/^ahk_native_[a-f0-9]{64}$/.test(body.key))
    throw new Error('Invalid native key response.');
  return { record, key: body.key };
}
function NativeKeyRows({
  keys,
  busy,
  revoke,
}: {
  keys: NativeKey[];
  busy: boolean;
  revoke: (id: string) => void;
}) {
  const [confirm, setConfirm] = useState('');
  return (
    <div className="divide-y rounded-lg border">
      {keys.map((key) => (
        <div key={key.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Native app key</p>
            <p className="text-xs text-muted-foreground">
              Created {new Date(key.created_at).toLocaleDateString()}
            </p>
          </div>
          {key.revoked_at !== null ? (
            <Badge variant="secondary">Revoked</Badge>
          ) : confirm === key.id ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs">Apps using this key will stop sending.</span>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  revoke(key.id);
                  setConfirm('');
                }}
              >
                Revoke now
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirm('')}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirm(key.id)}>
              Revoke native key
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
function NativeKeyError({
  error,
  busy,
  retry,
}: {
  error: string;
  busy: boolean;
  retry: () => void;
}) {
  return (
    <p role="alert" className="text-sm text-destructive">
      {error}
      <Button variant="link" size="sm" disabled={busy} onClick={retry}>
        Retry native keys
      </Button>
    </p>
  );
}
export function NativeKeys({ project, ownerToken, ingestOrigin }: Props) {
  const [keys, setKeys] = useState<NativeKey[]>([]);
  const [reveal, setReveal] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const url = `/v1/native-keys?${new URLSearchParams({ app_id: project.appId, environment_id: project.environmentId })}`;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const timer = setTimeout(() => {
      controller.abort();
      setLoading(false);
      setError('Native keys request timed out.');
    }, 8000);
    void nativeRequest(url, ownerToken, 'GET', controller.signal)
      .then((body) => {
        if (!controller.signal.aborted) setKeys(NativeKey.array().max(25).parse(body.keys));
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('Native keys could not load.');
      })
      .finally(() => {
        clearTimeout(timer);
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [url, ownerToken, refresh]);
  async function mutate(method: 'POST' | 'DELETE', id?: string) {
    setBusy(true);
    setError('');
    try {
      const body = await nativeRequest(
        id ? `${url}&id=${encodeURIComponent(id)}` : url,
        ownerToken,
        method,
      );
      if (method === 'POST') {
        const created = parseNativeCreation(body);
        setReveal(created.key);
        setKeys((rows) => [created.record, ...rows]);
      } else {
        setReveal('');
        setKeys((rows) =>
          rows.map((row) => (row.id === id ? { ...row, revoked_at: Date.now() } : row)),
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Native key update failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle>Swift apps</CardTitle>
        <CardDescription>
          Connect your iOS and Mac apps with one small SDK for named events, logs, and foreground
          sessions.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? (
          <NativeKeyError
            error={error}
            busy={busy}
            retry={() => setRefresh((value) => value + 1)}
          />
        ) : null}
        <Button
          variant="outline"
          disabled={loading || busy || keys.filter((key) => key.revoked_at === null).length >= 5}
          onClick={() => void mutate('POST')}
        >
          Create native public key
        </Button>
        {loading ? <p className="text-sm text-muted-foreground">Loading native keys…</p> : null}
        {reveal ? <NativeKeyReveal value={reveal} origin={ingestOrigin} /> : null}
        {keys.length ? (
          <NativeKeyRows keys={keys} busy={busy} revoke={(id) => void mutate('DELETE', id)} />
        ) : null}
      </CardContent>
    </Card>
  );
}
