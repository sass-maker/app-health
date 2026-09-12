import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(public ctx: DurableObjectState) {}
  },
}));
import { WorkspacePresence } from '../src/browser-presence.js';
import { PRESENCE_TTL_MS } from '@app-health/contracts';
class Socket {
  attachment = { expires: Date.now() + 60000 };
  send = vi.fn();
  close = vi.fn();
  serializeAttachment(value: { expires: number }) {
    this.attachment = value;
  }
  deserializeAttachment() {
    return this.attachment;
  }
}
function fixture() {
  const db = new DatabaseSync(':memory:');
  const sockets: Socket[] = [];
  const statements: string[] = [];
  let alarm: number | null = null;
  const storage = {
    sql: {
      exec(query: string, ...params: (string | number)[]) {
        statements.push(query);
        const rows = db.prepare(query).all(...params);
        return { toArray: () => rows, one: () => rows[0] };
      },
    },
    getAlarm: vi.fn(async () => alarm),
    setAlarm: vi.fn(async (next: number) => {
      alarm = next;
    }),
  };
  const ctx = {
    storage,
    getWebSockets: () => sockets,
    acceptWebSocket: (socket: Socket) => sockets.push(socket),
  };
  const presence = new WorkspacePresence(ctx as unknown as DurableObjectState, {});
  return { db, presence, sockets, storage, statements };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('does no grouped scans without viewers and coalesces repeated session writes', async () => {
  vi.useFakeTimers();
  const { db, presence, statements, storage } = fixture();
  for (let index = 0; index < 100; index++) await presence.heartbeat('a', 'prod', 'same');
  expect(statements.filter((sql) => sql.includes('GROUP BY'))).toHaveLength(0);
  expect(statements.filter((sql) => sql.startsWith('INSERT INTO presence'))).toHaveLength(1);
  expect(statements.filter((sql) => sql.includes('COUNT(*) AS count'))).toHaveLength(1);
  expect(storage.setAlarm).toHaveBeenCalledTimes(1);
  expect(storage.setAlarm).toHaveBeenLastCalledWith(Date.now() + 45_000);
  vi.advanceTimersByTime(45_000);
  storage.setAlarm.mockClear();
  await presence.alarm();
  expect(storage.setAlarm).not.toHaveBeenCalled();
  expect(presence.snapshot().total).toBe(0);
  db.close();
});
it('delivers a coalesced presence change after one second without waiting for expiry cleanup', async () => {
  vi.useFakeTimers();
  const { db, presence, sockets, storage } = fixture();
  const socket = new Socket();
  sockets.push(socket);
  await presence.heartbeat('a', 'prod', 'one');
  vi.advanceTimersByTime(100);
  await presence.heartbeat('a', 'prod', 'two');
  expect(socket.send).toHaveBeenCalledTimes(1);
  expect(storage.setAlarm).toHaveBeenLastCalledWith(Date.now() + 900);
  vi.advanceTimersByTime(900);
  await presence.alarm();
  expect(socket.send).toHaveBeenCalledTimes(2);
  expect(JSON.parse(socket.send.mock.calls[1][0]).total).toBe(2);
  db.close();
});
it('keeps exact scoped sessions in SQLite, dedupes heartbeats and expires inactive sessions', async () => {
  vi.useFakeTimers();
  const { db, presence, sockets, storage } = fixture();
  const socket = new Socket();
  sockets.push(socket);
  await presence.heartbeat('a', 'prod', 's');
  await presence.heartbeat('a', 'prod', 's');
  expect(socket.send).toHaveBeenCalledTimes(1);
  await presence.heartbeat('b', 'prod', 's');
  expect(presence.snapshot().total).toBe(2);
  vi.advanceTimersByTime(30000);
  await presence.heartbeat('a', 'prod', 's');
  vi.advanceTimersByTime(15000);
  await presence.alarm();
  expect(presence.snapshot().projects).toEqual([
    { app_id: 'a', environment_id: 'prod', active: 1 },
  ]);
  expect(storage.setAlarm).toHaveBeenCalled();
  vi.advanceTimersByTime(16000);
  await presence.alarm();
  expect(socket.close).toHaveBeenCalledWith(4001, 'Reauthenticate');
  vi.advanceTimersByTime(45000);
  await presence.alarm();
  expect(presence.snapshot().total).toBe(0);
  db.close();
});
it('publicSnapshot counts only the requested live scope and redacts session identity', async () => {
  vi.useFakeTimers();
  const now = new Date('2026-09-12T00:00:00.000Z');
  vi.setSystemTime(now);
  const { db, presence } = fixture();
  await presence.heartbeat('app-a', 'production', 'expired-session');
  vi.advanceTimersByTime(30_000);
  await presence.heartbeat('app-a', 'production', 'live-session');
  await presence.heartbeat('app-b', 'production', 'other-app-session');
  await presence.heartbeat('app-a', 'staging', 'other-environment-session');
  vi.advanceTimersByTime(20_000);
  const snapshot = presence.publicSnapshot('app-a', 'production');
  expect(snapshot).toEqual({ active: 1, measured_at: now.getTime() + 50_000, ttl_ms: 45_000 });
  expect(Object.keys(snapshot).sort()).toEqual(['active', 'measured_at', 'ttl_ms']);
  expect(JSON.stringify(snapshot)).not.toContain('session');
  expect(JSON.stringify(snapshot)).not.toContain('app-a');
  db.close();
});
it('bounds distinct scopes while allowing existing scopes and expired scope slots to be reused', async () => {
  vi.useFakeTimers();
  const { db, presence } = fixture();
  const now = Date.now();
  const insert = db.prepare('INSERT INTO presence VALUES (?, ?, ?, ?)');
  for (let index = 0; index < 1000; index++)
    insert.run(`app-${index}`, 'production', `session-${index}`, now);

  await expect(
    presence.heartbeat('app-0', 'production', 'another-session'),
  ).resolves.toBeUndefined();
  await expect(presence.heartbeat('app-new', 'production', 'new-session')).rejects.toThrow(
    'scope capacity',
  );

  vi.advanceTimersByTime(PRESENCE_TTL_MS);
  await presence.alarm();
  await expect(presence.heartbeat('app-new', 'production', 'new-session')).resolves.toBeUndefined();
  db.close();
});
it('rejects non-upgrades and excess connections and closes read-only/error frames', async () => {
  const { db, presence, sockets } = fixture();
  expect((await presence.fetch(new Request('https://presence'))).status).toBe(426);
  for (let i = 0; i < 20; i++) sockets.push(new Socket());
  expect(
    (await presence.fetch(new Request('https://presence', { headers: { upgrade: 'websocket' } })))
      .status,
  ).toBe(429);
  const socket = sockets[0] as unknown as WebSocket;
  presence.webSocketMessage(socket);
  expect(sockets[0].close).toHaveBeenCalledWith(1008, 'Read-only stream');
  presence.webSocketClose(socket, 1000);
  expect(sockets[0].close).toHaveBeenCalledWith(1000);
  presence.webSocketError(socket);
  expect(sockets[0].close).toHaveBeenCalledWith(1011, 'Connection unavailable');
  sockets[0].send.mockImplementation(() => {
    throw new Error('closed');
  });
  await presence.heartbeat('a', 'e', 's');
  db.close();
});
