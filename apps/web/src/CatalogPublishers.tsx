import { useEffect, useState } from 'react';
import {
  CatalogPublisherPairingV1,
  CatalogPublisherIdentityV1,
  CatalogPublishersV1,
  CatalogSyncStatusV1,
  type CatalogPublisher,
  type CatalogSyncStatus,
} from '@app-health/contracts';
import { Button } from '@saas-maker/ui/components/button';
import { Input } from '@saas-maker/ui/components/input';
import { ownerFetch } from './lib/owner-fetch.js';
import { useWorkspaceScope, workspaceScope } from './lib/workspace-scope.js';
import { pollWhileVisible } from './lib/visible-poll.js';

async function responseValue(response: Response) {
  const value = (await response.json().catch(() => null)) as { error?: unknown } | null;
  if (!response.ok)
    throw new Error(
      typeof value?.error === 'string'
        ? value.error
        : 'Catalog connection is unavailable. Retry shortly.',
    );
  return value;
}
const errorText = {
  invalid_catalog: 'The source catalog is invalid. The last good portfolio is retained.',
  source_unavailable: 'The local source file is unavailable. The last good portfolio is retained.',
  service_unavailable: 'The publisher could not reach App Health. It will retry automatically.',
  review_required:
    'Outside-project decisions changed and need owner review. The last good portfolio is retained.',
  conflict: 'The catalog changed during synchronization. The publisher will retry.',
};

function usePublisherState() {
  const scope = useWorkspaceScope();
  const [open, setOpen] = useState(false);
  const [publishers, setPublishers] = useState<CatalogPublisher[]>([]);
  const [code, setCode] = useState('');
  const [reviewed, setReviewed] = useState<{
    code?: string;
    publisherId?: string;
    label: string;
    status: CatalogSyncStatus;
  } | null>(null);
  const [outside, setOutside] = useState<string[]>([]);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const current = () => workspaceScope().epoch === scope.epoch;
  const load = async () => {
    const result = CatalogPublishersV1.parse(
      await responseValue(await ownerFetch('/v1/catalog/publishers', '')),
    );
    if (current()) setPublishers(result.publishers);
  };
  useEffect(() => {
    setCode('');
    setReviewed(null);
    setOutside([]);
    setConsent(false);
    setMessage('');
    setPublishers([]);
    setBusy(false);
  }, [scope.id, scope.sessionEpoch, scope.epoch]);
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    const refresh = () => {
      void load().catch(() => {
        if (!disposed && current())
          setMessage('Catalog connections are unavailable. Retry shortly.');
      });
    };
    refresh();
    const stop = pollWhileVisible(refresh, 30_000);
    return () => {
      disposed = true;
      stop();
    };
  }, [open, scope.epoch]);
  return {
    open,
    setOpen,
    publishers,
    code,
    setCode,
    reviewed,
    setReviewed,
    outside,
    setOutside,
    consent,
    setConsent,
    busy,
    setBusy,
    message,
    setMessage,
    current,
    load,
  };
}
type PublisherState = ReturnType<typeof usePublisherState>;

async function publisherAction(state: PublisherState, action: () => Promise<void>) {
  state.setBusy(true);
  state.setMessage('');
  try {
    await action();
  } catch (error) {
    if (state.current())
      state.setMessage(error instanceof Error ? error.message : 'Connection unavailable');
  } finally {
    if (state.current()) state.setBusy(false);
  }
}
function publisherActions(state: PublisherState) {
  const { reviewed, consent, outside, current, code } = state;
  const review = (publisher?: CatalogPublisher) =>
    publisherAction(state, async () => {
      state.setReviewed(null);
      state.setConsent(false);
      state.setOutside([]);
      const pairing =
        publisher ??
        CatalogPublisherPairingV1.parse(
          await responseValue(await ownerFetch(`/v1/catalog/publishers/pairing?code=${code}`, '')),
        );
      const status = CatalogSyncStatusV1.parse(
        await responseValue(await ownerFetch('/v1/catalog/sync', '')),
      );
      if (current())
        state.setReviewed({
          code: publisher ? undefined : code,
          publisherId: publisher?.id,
          label: pairing.label,
          status,
        });
    });
  const approve = async () => {
    if (!reviewed || !consent || outside.length !== reviewed.status.unlinked_apps.length) return;
    await publisherAction(state, async () => {
      CatalogPublisherIdentityV1.parse(
        await responseValue(
          await ownerFetch(
            reviewed.publisherId
              ? '/v1/catalog/publishers/review'
              : '/v1/catalog/publishers/approve',
            '',
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                ...(reviewed.publisherId
                  ? { publisher_id: reviewed.publisherId }
                  : { code: reviewed.code }),
                allow_automatic_updates: true,
                preserve_outside_catalog_app_ids: outside,
              }),
            },
          ),
        ),
      );
      if (!current()) return;
      state.setCode('');
      state.setReviewed(null);
      state.setConsent(false);
      state.setOutside([]);
      state.setMessage(
        reviewed.publisherId
          ? 'Outside-project decisions updated. The publisher will retry automatically.'
          : 'Connected. This Mac checks the canonical catalog every minute while it is running.',
      );
      await state.load();
    });
  };
  const revoke = (id: string) =>
    publisherAction(state, async () => {
      await responseValue(
        await ownerFetch('/v1/catalog/publishers/revoke', '', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ publisher_id: id }),
        }),
      );
      await state.load();
    });
  return { review, approve, revoke };
}

function PublisherConnections({
  state,
  revoke,
  review,
}: {
  state: PublisherState;
  revoke: (id: string) => Promise<void>;
  review: (publisher?: CatalogPublisher) => Promise<void>;
}) {
  const { publishers, busy } = state;
  return (
    <>
      {' '}
      {publishers.map((publisher) => (
        <div key={publisher.id} className="space-y-1 rounded-md border p-3">
          <p className="font-medium">
            {publisher.label} · {publisher.revoked_at ? 'disconnected' : 'connected'}
          </p>
          <p className="text-muted-foreground">
            {publisher.last_success_at
              ? `Last confirmed ${new Date(publisher.last_success_at).toLocaleString()}`
              : 'Waiting for the first check-in.'}
          </p>
          {!publisher.revoked_at && publisher.last_error ? (
            <p role="status">{errorText[publisher.last_error]}</p>
          ) : null}
          {!publisher.revoked_at &&
          (!publisher.last_attempt_at || Date.now() - publisher.last_attempt_at > 180_000) ? (
            <p role="status">
              Publisher has not checked in recently. Open the Mac and check that its background
              service is running.
            </p>
          ) : null}
          {!publisher.revoked_at && publisher.last_error === 'review_required' ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void review(publisher)}
            >
              Review outside projects
            </Button>
          ) : null}
          {!publisher.revoked_at ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void revoke(publisher.id)}
            >
              Disconnect publisher
            </Button>
          ) : null}
        </div>
      ))}
    </>
  );
}
function PublisherCodeForm({
  state,
  review,
}: {
  state: PublisherState;
  review: () => Promise<void>;
}) {
  const { code, busy, setCode, setReviewed, setConsent } = state;
  return (
    <>
      {' '}
      <label className="block space-y-1">
        <span>Connection code from your Mac</span>
        <Input
          aria-label="Connection code from your Mac"
          value={code}
          maxLength={12}
          disabled={busy}
          onChange={(event) => {
            setCode(event.target.value.toUpperCase().replace(/[^A-F0-9]/g, ''));
            setReviewed(null);
            setConsent(false);
          }}
          className="max-w-xs font-mono"
        />
      </label>
      <Button
        size="sm"
        variant="outline"
        disabled={busy || code.length !== 12}
        onClick={() => void review()}
      >
        Review connection
      </Button>
    </>
  );
}
function PublisherGrant({
  state,
  approve,
}: {
  state: PublisherState;
  approve: () => Promise<void>;
}) {
  const { reviewed, outside, setOutside, consent, setConsent, busy } = state;
  return (
    <>
      {' '}
      {reviewed ? (
        <div
          className="space-y-3 rounded-md border p-3"
          aria-label="Confirm automatic catalog connection"
        >
          <p className="font-medium">
            {reviewed.publisherId ? 'Review' : 'Connect'} {reviewed.label}
          </p>
          <p>
            This connection can update this workspace’s catalog metadata and monitoring policy. It
            cannot read telemetry, create ingest keys, or manage members. You can disconnect it here
            at any time.
          </p>
          {reviewed.status.unlinked_apps.map((app) => (
            <label key={app.app_id} className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={outside.includes(app.app_id)}
                onChange={(event) =>
                  setOutside(
                    event.target.checked
                      ? [...outside, app.app_id]
                      : outside.filter((id) => id !== app.app_id),
                  )
                }
              />
              <span>
                Keep {app.name} outside this catalog. Its history and keys remain available.
              </span>
            </label>
          ))}
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
            />
            <span>Allow automatic updates to this workspace from this connection.</span>
          </label>
          <Button
            size="sm"
            disabled={busy || !consent || outside.length !== reviewed.status.unlinked_apps.length}
            onClick={() => void approve()}
          >
            {reviewed.publisherId ? 'Resume automatic updates' : 'Connect automatic updates'}
          </Button>
        </div>
      ) : null}
    </>
  );
}
export function CatalogPublishers() {
  const state = usePublisherState();
  const actions = publisherActions(state);
  const { setOpen, message } = state;
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-xs font-medium">Automatic catalog updates</summary>
      <div className="mt-3 space-y-3 text-xs">
        <p className="leading-5 text-muted-foreground">
          Connect the publisher on your Mac to follow changes to the canonical JSON, including
          project removals. Private notes stay on the Mac. Updates pause while the Mac is asleep or
          offline.
        </p>
        <PublisherConnections state={state} revoke={actions.revoke} review={actions.review} />
        <PublisherCodeForm state={state} review={actions.review} />
        <PublisherGrant state={state} approve={actions.approve} />
        {message ? (
          <p role="status" className="break-words">
            {message}
          </p>
        ) : null}
      </div>
    </details>
  );
}
