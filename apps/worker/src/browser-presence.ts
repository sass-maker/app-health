import { DurableObject } from 'cloudflare:workers';
import { PRESENCE_TTL_MS, type PresenceSnapshot } from '@app-health/contracts';

const MAX_PRESENCE_SCOPES = 1000;

/** One coordination atom per workspace. No client can select its namespace. */
export class WorkspacePresence extends DurableObject<unknown> {
  private lastFrame = '';
  private nextCleanup = 0;
  private nextFrame = 0;
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS presence (app_id TEXT, environment_id TEXT, session TEXT, last_seen INTEGER, PRIMARY KEY (app_id, environment_id, session))',
    );
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS presence_expiry ON presence(last_seen)');
  }

  async heartbeat(appId: string, environmentId: string, session: string): Promise<void> {
    const now = Date.now();
    this.cleanup(now);
    this.recordHeartbeat(appId, environmentId, session, now);
    const next = this.broadcast() ?? now + this.alarmDelay();
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > next) await this.ctx.storage.setAlarm(next);
  }

  private recordHeartbeat(
    appId: string,
    environmentId: string,
    session: string,
    now: number,
  ): void {
    const previous = this.ctx.storage.sql
      .exec<{ last_seen: number }>(
        'SELECT last_seen FROM presence WHERE app_id = ? AND environment_id = ? AND session = ?',
        appId,
        environmentId,
        session,
      )
      .toArray()[0];
    if (previous && now - previous.last_seen < 5_000) return;
    if (!previous) {
      const scope = this.ctx.storage.sql
        .exec<{ present: number }>(
          'SELECT 1 AS present FROM presence WHERE app_id = ? AND environment_id = ? LIMIT 1',
          appId,
          environmentId,
        )
        .toArray()[0];
      if (!scope) {
        const scopes = this.ctx.storage.sql
          .exec<{ scope_count: number }>(
            'SELECT COUNT(*) AS scope_count FROM (SELECT DISTINCT app_id, environment_id FROM presence LIMIT ?)',
            MAX_PRESENCE_SCOPES,
          )
          .one().scope_count;
        if (scopes >= MAX_PRESENCE_SCOPES) throw new Error('presence scope capacity exceeded');
      }
      const count = this.ctx.storage.sql
        .exec<{ count: number }>('SELECT COUNT(*) AS count FROM presence')
        .one().count;
      if (count >= 20_000) throw new Error('presence capacity exceeded');
    }
    this.ctx.storage.sql.exec(
      'INSERT INTO presence VALUES (?, ?, ?, ?) ON CONFLICT (app_id, environment_id, session) DO UPDATE SET last_seen = excluded.last_seen',
      appId,
      environmentId,
      session,
      now,
    );
  }

  private cleanup(now: number): void {
    if (now < this.nextCleanup) return;
    this.ctx.storage.sql.exec('DELETE FROM presence WHERE last_seen <= ?', now - PRESENCE_TTL_MS);
    this.nextCleanup = now + 10_000;
  }

  private alarmDelay(): number {
    return this.ctx.getWebSockets().length ? 10_000 : PRESENCE_TTL_MS;
  }

  snapshot(): PresenceSnapshot {
    const now = Date.now();
    const projects = this.ctx.storage.sql
      .exec<{ app_id: string; environment_id: string; active: number }>(
        'SELECT app_id, environment_id, COUNT(*) AS active FROM presence WHERE last_seen > ? GROUP BY app_id, environment_id',
        now - PRESENCE_TTL_MS,
      )
      .toArray();
    return {
      measured_at: now,
      ttl_ms: PRESENCE_TTL_MS,
      total: projects.reduce((sum, row) => sum + row.active, 0),
      projects,
    };
  }

  /** Public pages receive only the requested environment's count, never workspace identities. */
  publicSnapshot(appId: string, environmentId: string) {
    const now = Date.now();
    const row = this.ctx.storage.sql
      .exec<{ active: number }>(
        'SELECT COUNT(*) AS active FROM presence WHERE app_id = ? AND environment_id = ? AND last_seen > ?',
        appId,
        environmentId,
        now - PRESENCE_TTL_MS,
      )
      .one();
    return { active: row.active, measured_at: now, ttl_ms: PRESENCE_TTL_MS };
  }

  /** Called only after the Worker authenticated the workspace and same-origin upgrade. */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
      return new Response('WebSocket required', { status: 426 });
    if (this.ctx.getWebSockets().length >= 20)
      return new Response('Too many viewers', { status: 429 });
    const pair = new WebSocketPair();
    pair[1].serializeAttachment({ expires: Date.now() + 60_000 });
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].send(JSON.stringify(this.snapshot()));
    const next = Date.now() + 10_000;
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > next) await this.ctx.storage.setAlarm(next);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private broadcast(): number | null {
    const sockets = this.ctx.getWebSockets();
    if (!sockets.length) return null;
    if (Date.now() < this.nextFrame) return this.nextFrame;
    this.nextFrame = Date.now() + 1_000;
    const snapshot = this.snapshot();
    const fingerprint = JSON.stringify(snapshot.projects);
    const changed = fingerprint !== this.lastFrame;
    this.lastFrame = fingerprint;
    const body = JSON.stringify(snapshot);
    for (const socket of sockets) {
      const attachment = socket.deserializeAttachment() as { expires: number };
      if (attachment.expires <= Date.now()) socket.close(4001, 'Reauthenticate');
      else if (changed) {
        try {
          socket.send(body);
        } catch {
          socket.close(1011, 'Connection unavailable');
        }
      }
    }
    return null;
  }

  override async alarm(): Promise<void> {
    this.cleanup(Date.now());
    this.broadcast();
    if (
      this.ctx.getWebSockets().length > 0 ||
      this.ctx.storage.sql.exec('SELECT 1 FROM presence LIMIT 1').toArray().length
    )
      await this.ctx.storage.setAlarm(Date.now() + this.alarmDelay());
  }

  override webSocketMessage(socket: WebSocket): void {
    socket.close(1008, 'Read-only stream');
  }
  override webSocketClose(socket: WebSocket, code: number): void {
    socket.close(code);
  }
  override webSocketError(socket: WebSocket): void {
    socket.close(1011, 'Connection unavailable');
  }
}
