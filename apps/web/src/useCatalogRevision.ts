import { useEffect, useRef } from 'react';
import { CatalogSyncStatusV1 } from '@app-health/contracts';
import { CATALOG_SYNC_EVENT, type CatalogSyncCommit } from './CatalogSync.js';
import { ownerFetch } from './lib/owner-fetch.js';
import { pollWhileVisible } from './lib/visible-poll.js';
import { useWorkspaceScope, workspaceScope } from './lib/workspace-scope.js';

export function useCatalogRevision(enabled: boolean, count: number, loaded: boolean) {
  const scope = useWorkspaceScope();
  const observed = useRef<string | null>(null);
  const countRef = useRef(count);
  countRef.current = count;
  useEffect(() => {
    observed.current = null;
  }, [scope.id, scope.sessionEpoch]);
  useEffect(() => {
    if (!enabled || !loaded || scope.role !== 'owner') return;
    let disposed = false;
    let pending = false;
    const refresh = async () => {
      if (pending || disposed) return;
      pending = true;
      const started = workspaceScope();
      try {
        const response = await ownerFetch('/v1/catalog/sync', '');
        if (!response.ok) return;
        const status = CatalogSyncStatusV1.parse(await response.json());
        if (
          disposed ||
          started.epoch !== workspaceScope().epoch ||
          !status.source ||
          !status.projection_hash
        )
          return;
        const changed =
          observed.current !== status.projection_hash || status.project_count !== countRef.current;
        observed.current = status.projection_hash;
        if (changed)
          window.dispatchEvent(
            new CustomEvent<CatalogSyncCommit>(CATALOG_SYNC_EVENT, {
              detail: {
                epoch: started.epoch,
                listed: null,
                projectCount: status.project_count!,
                automatic: true,
              },
            }),
          );
      } catch {
        /* A failed freshness read does not replace the current inventory. */
      } finally {
        pending = false;
      }
    };
    void refresh();
    const focused = () => {
      void refresh();
    };
    const stop = pollWhileVisible(focused, 30_000);
    window.addEventListener('focus', focused);
    return () => {
      disposed = true;
      stop();
      window.removeEventListener('focus', focused);
    };
  }, [enabled, loaded, scope.id, scope.role, scope.sessionEpoch]);
}
