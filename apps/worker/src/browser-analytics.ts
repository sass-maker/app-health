import {
  PRESENCE_TTL_MS,
  type BrowserEventV1,
  type BrowserAttribution,
  type BrowserReportFilter,
  type BrowserSummary,
  type PresenceSnapshot,
} from '@app-health/contracts';
import { localBrowserReport } from './browser-reports.js';
import type { AnalyticsEngineDatasetLike } from './analytics-engine.js';
import type { BrowserArchiveStageResult } from './browser-archive.js';

export async function browserSessionScope(
  appId: string,
  environmentId: string,
  session: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${appId}\u0000${environmentId}\u0000${session}`),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface CollectedBrowserBatch {
  workspace: string;
  app_id: string;
  environment_id: string;
  batch_id: string;
  received_at: number;
  events: BrowserEventV1[];
  /** Scoped one-way session identifier; raw browser session IDs never persist. */
  session_hash?: string;
  visitor_hash?: string;
  visit_type?: 'new' | 'returning';
  attribution?: BrowserAttribution;
  metadata?: { channel: string; device: string; browser: string; country: string };
}
export interface BrowserBindings {
  BROWSER_EVENTS?: { send(batch: CollectedBrowserBatch): Promise<unknown> };
  BROWSER_HISTORY?: Pick<R2Bucket, 'put' | 'list' | 'delete'>;
  BROWSER_ARCHIVE?: {
    getByName(name: string): {
      stage(batches: CollectedBrowserBatch[]): Promise<BrowserArchiveStageResult>;
    };
  };
  BROWSER_ANALYTICS?: AnalyticsEngineDatasetLike;
  WORKSPACE_PRESENCE?: {
    getByName(name: string): {
      heartbeat(appId: string, environmentId: string, session: string): Promise<void>;
      snapshot(): Promise<PresenceSnapshot>;
      publicSnapshot?(
        appId: string,
        environmentId: string,
      ): Promise<{ active: number; measured_at: number; ttl_ms: 45000 }>;
      fetch(request: Request): Promise<Response>;
    };
  };
}

export { projectBrowserBatch } from './browser-projection.js';

/** Credential-free development only; never used as a production fallback. */
export class LocalBrowserAnalytics {
  private batches = new Map<string, CollectedBrowserBatch>();
  private sessions = new Map<
    string,
    { app_id: string; environment_id: string; last_seen: number }
  >();
  ingest(batch: CollectedBrowserBatch, session?: string): void {
    for (const [id, saved] of this.batches)
      if (saved.received_at < Date.now() - 60 * 86_400_000) this.batches.delete(id);
    const batchKey = `${batch.app_id}/${batch.environment_id}/${batch.batch_id}`;
    if (batch.events.length && !this.batches.has(batchKey)) {
      if (this.batches.size >= 10_000) throw new Error('local analytics capacity exceeded');
      this.batches.set(batchKey, batch);
    }
    if (!session) return;
    this.snapshot();
    const sessionKey = `${batch.app_id}/${batch.environment_id}/${session}`;
    if (this.sessions.size >= 20_000 && !this.sessions.has(sessionKey))
      throw new Error('local presence capacity exceeded');
    this.sessions.set(`${batch.app_id}/${batch.environment_id}/${session}`, {
      app_id: batch.app_id,
      environment_id: batch.environment_id,
      last_seen: Date.now(),
    });
  }
  snapshot(): PresenceSnapshot {
    const grouped = new Map<string, { app_id: string; environment_id: string; active: number }>();
    for (const [id, session] of this.sessions) {
      if (session.last_seen <= Date.now() - PRESENCE_TTL_MS) {
        this.sessions.delete(id);
        continue;
      }
      const key = `${session.app_id}/${session.environment_id}`;
      const row = grouped.get(key) ?? {
        app_id: session.app_id,
        environment_id: session.environment_id,
        active: 0,
      };
      row.active++;
      grouped.set(key, row);
    }
    const projects = [...grouped.values()];
    return {
      measured_at: Date.now(),
      ttl_ms: PRESENCE_TTL_MS,
      projects,
      total: projects.reduce((sum, row) => sum + row.active, 0),
    };
  }
  report(filter: BrowserReportFilter) {
    return localBrowserReport(this.batches.values(), filter);
  }
  summary(): BrowserSummary {
    const now = Date.now();
    const grouped = new Map<string, BrowserSummary['projects'][number]>();
    const sessionGroups = new Map<string, Set<string>>();
    for (const batch of this.batches.values()) {
      const key = `${batch.app_id}/${batch.environment_id}`;
      const row = grouped.get(key) ?? {
        app_id: batch.app_id,
        environment_id: batch.environment_id,
        pageviews: 0,
        events: 0,
        sessions: 0,
      };

      for (const event of batch.events) {
        if (event.timestamp < now - 86_400_000 || event.timestamp >= now) continue;
        if (event.type === 'pageview') row.pageviews++;
        else row.events++;
      }
      if (
        batch.session_hash &&
        batch.events.some((event) => event.timestamp >= now - 86_400_000 && event.timestamp < now)
      ) {
        const sessions = sessionGroups.get(key) ?? new Set<string>();
        sessions.add(batch.session_hash);
        sessionGroups.set(key, sessions);
        row.sessions = sessions.size;
      }
      if (row.pageviews || row.events) grouped.set(key, row);
    }
    return {
      enabled: true,
      source: 'local',
      sampled: false,
      projects: [...grouped.values()],
      live: this.snapshot(),
      stream: false,
    };
  }
}

/** AE is a best-effort, potentially sampled projection; durable archives are authoritative. */
export async function queryBrowserSummary(
  workspace: string,
  options: {
    accountId: string;
    token: string;
    fetchImpl?: typeof fetch;
  },
): Promise<Pick<BrowserSummary, 'projects' | 'sampled'>> {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(workspace) || !/^[a-f0-9]{32}$/i.test(options.accountId))
    throw new Error('invalid analytics scope');
  const now = Date.now();
  const response = await (options.fetchImpl ?? fetch)(
    `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${options.token}`, 'content-type': 'text/plain' },
      body: `SELECT blob1 AS app_id, blob2 AS environment_id, SUM(IF(blob3 = 'pageview', double1 * _sample_interval, 0.0)) AS pageviews, SUM(IF(blob3 = 'event', double1 * _sample_interval, 0.0)) AS events, COUNT(DISTINCT blob7) - MAX(IF(blob7 = '', 1, 0)) AS sessions, MAX(_sample_interval) AS sample_interval FROM app_health_browser_v1 WHERE index1 = '${workspace}' AND double2 >= ${now - 86_400_000} AND double2 < ${now} GROUP BY app_id, environment_id LIMIT 1001`,
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) throw new Error('browser analytics query unavailable');
  const body = (await response.json()) as {
    data: {
      app_id: string;
      environment_id: string;
      pageviews: string | number;
      events: string | number;
      sessions: string | number;
      sample_interval: string | number;
    }[];
  };
  if (!Array.isArray(body.data) || body.data.length > 1000)
    throw new Error('workspace analytics capacity exceeded');
  if (
    body.data.some(
      (row) =>
        typeof row.app_id !== 'string' ||
        typeof row.environment_id !== 'string' ||
        [row.pageviews, row.events, row.sessions, row.sample_interval].some(
          (value) => !Number.isFinite(Number(value)) || Number(value) < 0,
        ),
    )
  )
    throw new Error('invalid analytics response');
  return {
    sampled: body.data.some((row) => Number(row.sample_interval) > 1),
    projects: body.data.map((row) => ({
      app_id: row.app_id,
      environment_id: row.environment_id,
      pageviews: Number(row.pageviews),
      events: Number(row.events),
      sessions: Number(row.sessions),
    })),
  };
}
