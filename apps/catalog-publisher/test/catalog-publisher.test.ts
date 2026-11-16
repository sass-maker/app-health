import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import process from 'node:process';
import { publishOnce, publisherRequest } from '../src/catalog-publisher.js';

afterEach(() => vi.unstubAllGlobals());
const id = '11111111-1111-4111-8111-111111111111';
const secret = `ahcp_${'a'.repeat(64)}`;
function canonical() {
  return {
    catalogSchemaVersion: 2,
    privateNotes: 'PRIVATE_CANARY',
    projects: ['one', 'two'].map((id) => ({
      id,
      name: id,
      lifecycle: { portfolioStatus: 'active' },
      classification: { kind: 'product', futureForm: 'support-tool' },
      deployment: { authModel: 'local-only' },
      systems: { probe: { scope: 'local', absent: 'PRIVATE_CANARY' } },
      localPath: '/private/canary',
    })),
  };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'catalog-publisher-test-'));
  const catalog = join(directory, 'projects.json');
  await writeFile(catalog, JSON.stringify(canonical()));
  const config = {
    origin: 'https://health.example.test',
    catalog,
    publisherId: id,
    code: 'A'.repeat(12),
  };
  let hash: string | null = null;
  let count: number | null = null;
  let fail = 0;
  const writes: unknown[] = [];
  const calls: { path: string; body: unknown }[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    expect(options?.redirect).toBe('error');
    const path = new URL(String(url)).pathname;
    const body = options?.body ? JSON.parse(String(options.body)) : null;
    calls.push({ path, body });
    if (path.endsWith('/error')) return Response.json({ ok: true });
    if (options?.method === 'POST') {
      if (fail) {
        const status = fail;
        fail = 0;
        return Response.json({ error: 'PRIVATE_SERVER_CANARY' }, { status });
      }
      writes.push(body);
      hash = createHash('sha256')
        .update(JSON.stringify({ projects: body.projects, monitoring: body.monitoring }))
        .digest('hex');
      count = body.projects.length;
      return Response.json({ projection_hash: hash, project_count: count });
    }
    return Response.json({
      state: 'approved',
      publisher_id: id,
      label: 'Mac',
      expires_at: 1,
      projection_hash: hash,
      project_count: count,
    });
  });
  vi.stubGlobal('fetch', fetcher);
  return {
    directory,
    catalog,
    config,
    calls,
    writes,
    fetcher,
    failNext: (status: number) => {
      fail = status;
    },
  };
}

describe('local canonical catalog publisher', () => {
  it('publishes only the shared allowlist, follows removals and avoids unchanged snapshot writes', async () => {
    const f = await fixture();
    expect(await publishOnce(f.config, secret, 0)).toEqual({ state: 'synchronized', count: 2 });
    expect(JSON.stringify(f.writes)).not.toMatch(/PRIVATE_CANARY|localPath|\/private/);
    expect(await publishOnce(f.config, secret, 0)).toEqual({ state: 'current', count: 2 });
    expect(f.writes).toHaveLength(1);
    const next = canonical();
    next.projects.pop();
    await writeFile(f.catalog, JSON.stringify(next));
    expect(await publishOnce(f.config, secret, 0)).toEqual({ state: 'synchronized', count: 1 });
    expect(f.writes).toHaveLength(2);
    expect(f.writes.at(-1)).toMatchObject({
      expected_previous_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
  it('retains the last good portfolio for a missing, invalid, oversized or empty source and reports only a safe code', async () => {
    const f = await fixture();
    await publishOnce(f.config, secret, 0);
    for (const raw of [
      '{ "private": "PRIVATE_CANARY"',
      JSON.stringify({ catalogSchemaVersion: 2, projects: [] }),
      'x'.repeat(8 * 1024 * 1024 + 1),
    ]) {
      await writeFile(f.catalog, raw);
      await expect(publishOnce(f.config, secret, 0)).rejects.toMatchObject({
        code: 'invalid_catalog',
      });
    }
    await expect(
      publishOnce({ ...f.config, catalog: join(f.directory, 'missing.json') }, secret, 0),
    ).rejects.toMatchObject({ code: 'source_unavailable' });
    expect(f.writes).toHaveLength(1);
    expect(JSON.stringify(f.calls)).not.toContain('PRIVATE_CANARY');
    expect(f.calls.at(-1)?.body).toEqual({ error: 'source_unavailable' });
  });
  it('retries a revision conflict against the latest stable source and recovers after a service outage', async () => {
    const f = await fixture();
    f.failNext(409);
    expect(await publishOnce(f.config, secret, 0)).toEqual({ state: 'synchronized', count: 2 });
    const changed = canonical();
    changed.projects[0]!.name = 'Renamed';
    await writeFile(f.catalog, JSON.stringify(changed));
    f.failNext(503);
    await expect(publishOnce(f.config, secret, 0)).rejects.toMatchObject({
      code: 'service_unavailable',
      status: 503,
    });
    expect(await publishOnce(f.config, secret, 0)).toEqual({ state: 'synchronized', count: 2 });
    expect(JSON.stringify(f.writes.at(-1))).toContain('Renamed');
  });
  it('does not claim success from a malformed acknowledgement or an HTML gateway response', async () => {
    const f = await fixture();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('PRIVATE_SERVER_CANARY', { headers: { 'content-type': 'text/html' } }),
      ),
    );
    await expect(publishOnce(f.config, secret, 0)).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    let requested = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ++requested === 1
          ? Response.json({
              state: 'approved',
              publisher_id: id,
              label: 'Mac',
              expires_at: 1,
              projection_hash: null,
              project_count: null,
            })
          : Response.json({ project_count: 2 }),
      ),
    );
    await expect(publishOnce(f.config, secret, 0)).rejects.toMatchObject({
      code: 'service_unavailable',
    });
  });
  it('rejects redirects, credentials, HTTP and unintended paths at the authenticated transport boundary', async () => {
    const f = await fixture();
    for (const origin of [
      'http://localhost',
      'https://user:pass@health.example.test',
      'https://health.example.test/path',
    ])
      await expect(publisherRequest(origin, '/v1/catalog/publisher', secret)).rejects.toMatchObject(
        { code: 'service_unavailable' },
      );
    await expect(
      publisherRequest(f.config.origin, '/v1/analytics/report', secret),
    ).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});

it.skipIf(process.platform !== 'darwin')(
  'kernel lock excludes another process and releases after a crash',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'catalog-publisher-lock-'));
    const helper = join(directory, 'keychain-helper');
    const source = resolve(import.meta.dirname, '../src/catalog-keychain.swift');
    const build = spawnSync('/usr/bin/swiftc', [source, '-o', helper], { encoding: 'utf8' });
    expect(build.status, build.stderr).toBe(0);
    const marker = join(directory, 'entered');
    const lock = join(directory, 'run.lock');
    const code = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'entered'); setInterval(() => {}, 1000);`;
    const child = spawn(helper, ['lock', lock, process.execPath, '-e', code], { stdio: 'ignore' });
    try {
      for (let index = 0; index < 100; index += 1) {
        if ((await readFile(marker, 'utf8').catch(() => '')) === 'entered') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(await readFile(marker, 'utf8')).toBe('entered');
      const blocked = spawnSync(helper, ['lock', lock, process.execPath, '-e', 'process.exit(0)']);
      expect(blocked.status).toBe(75);
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      const resumed = spawnSync(helper, ['lock', lock, process.execPath, '-e', 'process.exit(0)']);
      expect(resumed.status).toBe(0);
    } finally {
      child.kill('SIGKILL');
    }
  },
  30_000,
);
