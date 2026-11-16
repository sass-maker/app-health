import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  ListAppsResponseV1,
  CatalogSyncStatusV1,
  type CatalogSyncStatus,
  projectCanonicalCatalogWithRevisions,
  type CatalogSyncRequest,
} from '@app-health/contracts';
import { Button } from '@saas-maker/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@saas-maker/ui/components/card';
import { ownerFetch } from './lib/owner-fetch.js';
import { useWorkspaceScope, workspaceScope } from './lib/workspace-scope.js';
import { CatalogPublishers } from './CatalogPublishers.js';

export interface CatalogSyncCommit {
  epoch: number;
  listed: ListAppsResponseV1 | null;
  projectCount: number;
  automatic?: boolean;
}

export const CATALOG_SYNC_EVENT = 'app-health-catalog-synchronized';
const MAX_FILE_BYTES = 8 * 1024 * 1024;
function counts(
  projects: CatalogSyncRequest['projects'],
  field: 'kind' | 'future_form' | 'auth_model',
) {
  const result = new Map<string, number>();
  for (const project of projects) result.set(project[field], (result.get(project[field]) ?? 0) + 1);
  return [...result].map(([label, count]) => `${count} ${label}`).join(' · ');
}

function useCatalogState(ownerToken: string) {
  const scope = useWorkspaceScope();
  const [preview, setPreview] = useState<CatalogSyncRequest | null>(null);
  const [message, setMessage] = useState('');
  const [statusError, setStatusError] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<CatalogSyncStatus | null>(null);
  const generation = useRef(0);
  const statusGeneration = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    generation.current += 1;
    statusGeneration.current += 1;
    activeRequest.current?.abort();
    setPreview(null);
    setStatus(null);
    setMessage('');
    setStatusError('');
    setBusy(false);
    if (fileInput.current) fileInput.current.value = '';
    return () => {
      generation.current += 1;
      statusGeneration.current += 1;
      activeRequest.current?.abort();
    };
  }, [scope.epoch, scope.role, ownerToken]);
  useCatalogStatus(ownerToken, scope, statusGeneration, setStatus, setStatusError);
  return {
    scope,
    preview,
    setPreview,
    message,
    setMessage,
    statusError,
    setStatusError,
    busy,
    setBusy,
    status,
    setStatus,
    generation,
    statusGeneration,
    activeRequest,
    fileInput,
  };
}

export function CatalogSync({ ownerToken }: { ownerToken: string }) {
  const state = useCatalogState(ownerToken);
  const {
    scope,
    preview,
    setPreview,
    setMessage,
    setStatusError,
    busy,
    setBusy,
    status,
    setStatus,
    generation,
    statusGeneration,
    activeRequest,
    fileInput,
  } = state;
  const previewGeneration = generation.current;
  if (scope.role !== 'owner' || ownerToken) return null;

  async function readFile(file: File | undefined) {
    const epoch = scope.epoch;
    const run = ++generation.current;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    const current = () =>
      run === generation.current && epoch === workspaceScope().epoch && !controller.signal.aborted;
    setPreview(null);
    setMessage('');
    if (!file) return;
    setBusy(true);
    let statusRun: number | undefined;
    try {
      if (file.size > MAX_FILE_BYTES) throw new Error('Catalog file exceeds 8 MiB.');
      const text = await file.text();
      if (!current()) return;
      const projection = await projectCanonicalCatalogWithRevisions(JSON.parse(text), null);
      if (!current()) return;
      statusRun = ++statusGeneration.current;
      setStatusError('');
      const response = await ownerFetch('/v1/catalog/sync', ownerToken, {
        signal: controller.signal,
      });
      const status = await readCatalogStatus(response);
      if (current() && statusRun === statusGeneration.current) {
        setStatus(status);
        setStatusError('');
        setPreview({ ...projection, expected_previous_hash: status.projection_hash });
      }
    } catch (error) {
      if (current()) {
        const message = catalogPreviewError(error);
        setMessage(message);
        if (statusRun === statusGeneration.current) setStatusError(message);
      }
    } finally {
      if (current()) setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }
  async function synchronize() {
    if (!preview || busy || unresolvedCatalogLinks(preview, status)) return;
    if (!catalogSubmissionCurrent(scope.epoch, previewGeneration, generation.current)) return;
    const epoch = scope.epoch;
    const run = ++generation.current;
    statusGeneration.current += 1;
    const controller = new AbortController();
    activeRequest.current = controller;
    const current = () =>
      run === generation.current && epoch === workspaceScope().epoch && !controller.signal.aborted;
    setBusy(true);
    setMessage('');
    try {
      const response = await ownerFetch('/v1/catalog/sync', ownerToken, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(preview),
      });
      const projectCount = await readCatalogAcknowledgement(response, preview.projects.length);
      if (!current()) return;
      setPreview(null);
      const listed = await readCommittedInventory(ownerToken, controller.signal);
      if (!current()) return;
      publishCatalogCommit(epoch, listed, projectCount, setMessage);
    } catch (error) {
      if (current())
        setMessage(error instanceof Error ? error.message : 'Catalog synchronization failed.');
    } finally {
      if (current()) setBusy(false);
    }
  }
  return <CatalogSyncCard state={state} readFile={readFile} synchronize={synchronize} />;
}

type CatalogSyncState = ReturnType<typeof useCatalogState>;
type CatalogSyncAction = () => Promise<void>;

function CatalogSyncCard({
  state,
  readFile,
  synchronize,
}: {
  state: CatalogSyncState;
  readFile: (file: File | undefined) => Promise<void>;
  synchronize: CatalogSyncAction;
}) {
  const { status, preview, busy, fileInput, message, statusError } = state;
  return (
    <Card className="gap-3 py-5 shadow-none">
      <CardHeader className="px-5 py-0">
        <CardTitle className="text-sm">SaaS Maker catalog</CardTitle>
        <p className="text-sm font-medium">
          {status?.project_count != null
            ? `SaaS Maker · ${status.project_count} active projects`
            : status
              ? 'No catalog imported yet'
              : statusError
                ? 'Catalog status unavailable'
                : 'Loading catalog status…'}
        </p>
        <p className="text-xs text-muted-foreground">
          {status?.updated_at ? (
            <>
              Last synchronized{' '}
              <time dateTime={new Date(status.updated_at).toISOString()}>
                {new Date(status.updated_at).toLocaleString()}
              </time>
            </>
          ) : (
            'Review the active portfolio below.'
          )}
        </p>
      </CardHeader>
      <CardContent className="space-y-3 px-5 py-0">
        <CatalogPublishers />
        <details open={Boolean(preview)}>
          <summary className="cursor-pointer text-xs font-medium">
            {status?.project_count ? 'Update from catalog' : 'Import active portfolio'}
          </summary>
          <div className="mt-3 space-y-3">
            <p className="text-xs leading-5 text-muted-foreground">
              Import the canonical projects.json to select the active portfolio, including internal
              projects. Names, roles and access labels follow the catalog. Existing telemetry and
              keys stay attached to their projects.
            </p>
            <p className="text-xs text-muted-foreground">
              The file is projected locally. Only active project metadata, explicit metric
              applicability and monitoring scope are uploaded. Private notes and local paths stay in
              this browser.
            </p>
            <label className="flex flex-wrap items-center gap-3 text-sm">
              <span>Canonical catalog JSON</span>
              <input
                ref={fileInput}
                type="file"
                accept=".json,application/json"
                disabled={busy}
                className="min-w-0 max-w-full text-xs"
                onChange={(event) => void readFile(event.target.files?.[0])}
              />
            </label>
            <CatalogPreview state={state} synchronize={synchronize} />
          </div>
        </details>
        {busy && !preview ? (
          <p role="status" className="text-xs">
            Preparing catalog preview…
          </p>
        ) : null}
        {message || statusError ? (
          <p role="status" className="break-words text-xs">
            {message || statusError}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function CatalogPreview({
  state,
  synchronize,
}: {
  state: CatalogSyncState;
  synchronize: CatalogSyncAction;
}) {
  const { preview, busy, status, setPreview } = state;
  if (!preview) return null;
  return (
    <div className="space-y-2 rounded-lg border p-3 text-xs" aria-label="Catalog preview">
      <p className="text-sm font-medium">{preview.projects.length} active projects</p>
      <CatalogLinkPreview
        preview={preview}
        status={status}
        onOutsideChange={(appId, checked) =>
          setPreview((current) =>
            current
              ? {
                  ...current,
                  preserve_outside_catalog_app_ids: checked
                    ? [...current.preserve_outside_catalog_app_ids, appId]
                    : current.preserve_outside_catalog_app_ids.filter((id) => id !== appId),
                }
              : null,
          )
        }
      />
      <p className="break-words">{counts(preview.projects, 'kind')}</p>
      <p className="break-words">{counts(preview.projects, 'future_form')}</p>
      <p className="break-words">{counts(preview.projects, 'auth_model')}</p>
      <p>
        {preview.monitoring.projects.filter((row) => row.scope === 'public').length} public
        monitoring projects ·{' '}
        {preview.monitoring.projects.reduce((sum, row) => sum + row.journeys.length, 0)} reviewed
        journeys · {preview.monitoring.projects.filter((row) => row.scope !== 'public').length}{' '}
        explicit local or private limits
      </p>
      <Button
        size="sm"
        disabled={busy || unresolvedCatalogLinks(preview, status)}
        onClick={() => void synchronize()}
      >
        {busy ? 'Synchronizing…' : 'Synchronize active portfolio'}
      </Button>
    </div>
  );
}

function unresolvedCatalogLinks(preview: CatalogSyncRequest, status: CatalogSyncStatus | null) {
  return (
    status?.unlinked_apps.some(
      (app) => !preview.preserve_outside_catalog_app_ids.includes(app.app_id),
    ) ?? false
  );
}

function CatalogLinkPreview({
  preview,
  status,
  onOutsideChange,
}: {
  preview: CatalogSyncRequest;
  status: CatalogSyncStatus | null;
  onOutsideChange: (appId: string, checked: boolean) => void;
}) {
  const mapped = new Set(status?.mapped_catalog_ids);
  const existing = preview.projects.filter((project) => mapped.has(project.catalog_id)).length;
  return (
    <div className="space-y-2">
      <p>
        {existing} selected projects already mapped · {preview.projects.length - existing} new
        metadata projects
      </p>
      {status?.unlinked_apps.length ? (
        <div
          role={unresolvedCatalogLinks(preview, status) ? 'alert' : 'status'}
          className="space-y-2 rounded-md border p-3"
        >
          <p className="font-medium">
            Review {status.unlinked_apps.length} unlinked workspace projects before synchronizing.
          </p>
          <p>
            If a project belongs to this active catalog, link it first through the owner catalog
            import API using existing_app_id. Then reload this preview. Names cannot establish a
            match.
          </p>
          <p>
            Otherwise, explicitly keep the project outside this catalog. Its keys, history and
            direct access remain available.
          </p>
          <ul className="space-y-2">
            {status.unlinked_apps.map((app) => (
              <li key={app.app_id}>
                <label className="flex items-start gap-2">
                  <input
                    className="mt-0.5 shrink-0"
                    type="checkbox"
                    checked={preview.preserve_outside_catalog_app_ids.includes(app.app_id)}
                    onChange={(event) => onOutsideChange(app.app_id, event.target.checked)}
                  />
                  <span className="min-w-0 break-words">
                    Keep {app.name} outside this catalog{' '}
                    <code className="block break-all text-muted-foreground">{app.app_id}</code>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function useCatalogStatus(
  ownerToken: string,
  scope: ReturnType<typeof workspaceScope>,
  statusGeneration: RefObject<number>,
  setStatus: (status: CatalogSyncStatus) => void,
  setStatusError: (message: string) => void,
) {
  useEffect(() => {
    if (scope.role !== 'owner' || ownerToken) return;
    const controller = new AbortController();
    let disposed = false;
    const run = statusGeneration.current;
    void ownerFetch('/v1/catalog/sync', ownerToken, { signal: controller.signal })
      .then(async (response) => {
        const value = await readCatalogStatus(response);
        if (
          !disposed &&
          scope.epoch === workspaceScope().epoch &&
          run === statusGeneration.current
        ) {
          setStatus(value);
          setStatusError('');
        }
      })
      .catch((error: unknown) => {
        if (!disposed && scope.epoch === workspaceScope().epoch && run === statusGeneration.current)
          setStatusError(catalogPreviewError(error));
      });
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [scope.epoch, scope.role, ownerToken]);
}

function catalogPreviewError(error: unknown) {
  if (error instanceof SyntaxError) return 'Choose a valid canonical catalog JSON file.';
  return error instanceof Error ? error.message : 'Catalog preview failed.';
}

function catalogSubmissionCurrent(
  epoch: number,
  expectedGeneration: number,
  actualGeneration: number,
) {
  return epoch === workspaceScope().epoch && expectedGeneration === actualGeneration;
}

async function readCatalogStatus(response: Response) {
  if (!response.ok) {
    const value = (await response.json().catch(() => null)) as { error?: unknown } | null;
    throw new Error(
      typeof value?.error === 'string'
        ? value.error
        : `Catalog status is unavailable (${response.status}). Retry the service request.`,
    );
  }
  try {
    return CatalogSyncStatusV1.parse(await response.json());
  } catch {
    throw new Error(
      'Catalog status returned an invalid service response. Retry the service request.',
    );
  }
}

async function readCommittedInventory(ownerToken: string, signal: AbortSignal) {
  try {
    const inventory = await ownerFetch('/v1/apps', ownerToken, { signal });
    return inventory.ok ? ListAppsResponseV1.parse(await inventory.json()) : null;
  } catch {
    return null;
  }
}

type CatalogAcknowledgement = { error?: unknown; project_count?: unknown };

async function readCatalogAcknowledgement(response: Response, expectedCount: number) {
  const value = (await response.json().catch(() => null)) as CatalogAcknowledgement | null;
  if (!response.ok)
    throw new Error(
      typeof value?.error === 'string'
        ? value.error
        : `Catalog synchronization is unavailable (${response.status}). Its outcome is unconfirmed. Refresh catalog status before retrying.`,
    );
  if (!value || value.project_count !== expectedCount)
    throw new Error(
      'Catalog synchronization returned an invalid acknowledgement. Its outcome is unconfirmed. Refresh catalog status before retrying.',
    );
  return expectedCount;
}

function publishCatalogCommit(
  epoch: number,
  listed: ListAppsResponseV1 | null,
  projectCount: number,
  setMessage: (message: string) => void,
) {
  setMessage(
    listed
      ? `Synchronized ${projectCount} active projects and their monitoring policy.`
      : `Catalog synchronized: ${projectCount} active projects. Inventory refresh is unavailable; retry its refresh.`,
  );
  window.dispatchEvent(
    new CustomEvent<CatalogSyncCommit>(CATALOG_SYNC_EVENT, {
      detail: { epoch, listed, projectCount },
    }),
  );
}
