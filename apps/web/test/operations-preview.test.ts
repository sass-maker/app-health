import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { operationsPreviewResponse, operationsRequestAllowed } from '../operations-preview.js';
import { readOperationsSnapshot, currentOperationsSnapshot } from '../src/lib/operations-model.js';
import { operationsFixture } from './operations-fixture.js';

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true });
});
const request = { method: 'GET', headers: { host: '127.0.0.1:4318' } };
it('refuses foreign hosts, origins, shared workspaces, methods and remote peers', () => {
  expect(operationsRequestAllowed(request)).toBe(true);
  expect(operationsRequestAllowed({ ...request, headers: { host: 'attacker.example' } })).toBe(
    false,
  );
  expect(
    operationsRequestAllowed({
      ...request,
      headers: { ...request.headers, origin: 'https://attacker.example' },
    }),
  ).toBe(false);
  expect(
    operationsRequestAllowed({
      ...request,
      headers: { ...request.headers, 'sec-fetch-site': 'cross-site' },
    }),
  ).toBe(false);
  expect(
    operationsRequestAllowed({
      ...request,
      headers: { ...request.headers, 'x-app-health-workspace': 'other' },
    }),
  ).toBe(false);
  expect(operationsRequestAllowed({ ...request, method: 'POST' })).toBe(false);
  expect(operationsRequestAllowed({ ...request, socket: { remoteAddress: '192.0.2.1' } })).toBe(
    false,
  );
});
it('fails closed without a snapshot and never exposes file paths in errors', async () => {
  expect((await operationsPreviewResponse(request)).status).toBe(404);
  const result = await operationsPreviewResponse(request, '/Users/private/missing.json');
  expect(result.status).toBe(503);
  expect(JSON.stringify(result)).not.toContain('/Users/');
});
it('serves a valid private snapshot while stripping unknown properties', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'app-health-ops-'));
  directories.push(dir);
  const path = join(dir, 'snapshot.json');
  await writeFile(
    path,
    JSON.stringify({ ...operationsFixture(), privatePath: '/Users/private/source' }),
  );
  const result = await operationsPreviewResponse(request, path);
  expect(result.status).toBe(200);
  expect(JSON.stringify(result.body)).not.toContain('/Users/');
});
it('rejects unsafe evidence, incomplete relationships and duplicate identities', () => {
  const unsafe = operationsFixture();
  unsafe.feeds[0].evidenceUrl = 'javascript:alert(1)';
  expect(() => readOperationsSnapshot(unsafe)).toThrow();
  const duplicate = operationsFixture();
  duplicate.feeds.push(duplicate.feeds[0]);
  expect(() => readOperationsSnapshot(duplicate)).toThrow();
  const orphan = operationsFixture();
  orphan.observations[0].feedId = 'missing';
  expect(() => readOperationsSnapshot(orphan)).toThrow();
});
it('does not refresh old source collection by rereading or generating a newer snapshot', () => {
  const snapshot = operationsFixture();
  snapshot.feeds[0].collectedAt = '2026-01-01T00:00:00Z';
  const result = currentOperationsSnapshot(snapshot, Date.parse('2026-11-07T00:00:00Z'));
  expect(result.feeds[0].freshness).toBe('stale');
  expect(result.feeds[0].collectedAt).toBe('2026-01-01T00:00:00Z');
  expect(result.feeds[0].health).toBe('failing');
});

it('keeps missing usage missing even when a historical observation timestamp exists', () => {
  const snapshot = operationsFixture();
  snapshot.feeds[1].freshness = 'missing';
  const result = currentOperationsSnapshot(snapshot, Date.parse('2026-11-07T00:00:00Z'));
  expect(result.feeds[1].freshness).toBe('missing');
});
