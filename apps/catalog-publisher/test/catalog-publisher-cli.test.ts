import { afterEach, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { runCatalogPublisher } from '../src/catalog-publisher-cli.js';

afterEach(() => vi.unstubAllGlobals());
const id = '11111111-1111-4111-8111-111111111111';
const token = `ahcp_${'a'.repeat(64)}`;
const code = 'ABCDEF123456';
const source = {
  catalogSchemaVersion: 2,
  privateNotes: 'PRIVATE_CANARY',
  projects: [
    {
      id: 'local',
      name: 'Local',
      lifecycle: { portfolioStatus: 'active' },
      classification: { kind: 'product', futureForm: 'personal-tool' },
      deployment: { authModel: 'local-only' },
      systems: { probe: { scope: 'local', absent: 'private' } },
    },
  ],
};
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'catalog-publisher-cli-'));
  const bundle = join(home, 'build');
  await mkdir(bundle);
  const entry = join(bundle, 'catalog-publisher.mjs');
  await writeFile(entry, 'published bundle');
  await writeFile(join(bundle, 'catalog-keychain'), 'published helper');
  const catalog = join(home, 'source.json');
  await writeFile(catalog, JSON.stringify(source));
  const output: unknown[] = [];
  const operations: { program: string; args: string[]; input?: string }[] = [];
  const execute = (program: string, args: string[], input?: string) => {
    operations.push({ program, args, input });
    if (args[0] === 'get') return token;
    if (args[0] === 'lock') return JSON.stringify({ state: 'busy' });
    if (args[0] === 'bootout') throw new Error('absent service');
    return '';
  };
  const host = {
    home,
    entry,
    platform: 'darwin',
    node: '/usr/local/node & runtime',
    uid: 501,
    locked: true,
    execute,
    output: (value: unknown) => {
      output.push(value);
    },
  };
  const directory = join(home, 'Library/Application Support/App Health/Catalog Publisher');
  const agent = join(home, 'Library/LaunchAgents/com.sassmaker.app-health.catalog-publisher.plist');
  let hash: string | null = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/enroll'))
        return Response.json({
          publisher_id: id,
          secret: token,
          code,
          expires_at: Date.now() + 60000,
        });
      if (url.endsWith('/error')) return Response.json({ ok: true });
      if (init?.method === 'POST') {
        const input = JSON.parse(String(init.body));
        hash = createHash('sha256')
          .update(JSON.stringify({ projects: input.projects, monitoring: input.monitoring }))
          .digest('hex');
        return Response.json({ projection_hash: hash, project_count: 1 });
      }
      return Response.json({
        state: 'approved',
        publisher_id: id,
        label: 'Mac',
        expires_at: 1,
        projection_hash: hash,
        project_count: hash ? 1 : null,
      });
    }),
  );
  return { home, catalog, host, output, operations, directory, agent };
}

it('installs an independent background runtime, pairs without persisting its token, runs and reports status safely', async () => {
  const f = await fixture();
  await runCatalogPublisher(['install'], f.host);
  expect(await readFile(join(f.directory, 'catalog-publisher.mjs'), 'utf8')).toBe(
    'published bundle',
  );
  const agent = await readFile(f.agent, 'utf8');
  expect(agent).toContain('/usr/local/node &amp; runtime');
  expect(agent).toContain('<integer>60</integer>');
  expect(agent).not.toContain(f.host.entry);
  await runCatalogPublisher(
    [
      'pair',
      '--catalog',
      f.catalog,
      '--origin',
      'https://health.example.test',
      '--label',
      'My Mac',
    ],
    f.host,
  );
  const connection = await readFile(join(f.directory, 'connection.json'), 'utf8');
  expect(connection).not.toContain(token);
  expect(f.operations.find((row) => row.args[0] === 'put')).toMatchObject({
    args: ['put', id],
    input: token,
  });
  await runCatalogPublisher(['check-source', '--catalog', f.catalog], f.host);
  await runCatalogPublisher(['run'], f.host);
  await runCatalogPublisher(['status'], f.host);
  expect(f.output.at(-1)).toMatchObject({ state: 'synchronized', count: 1 });
  expect(JSON.stringify(f.output)).not.toMatch(/ahcp_|PRIVATE_CANARY/);
  await runCatalogPublisher(['install'], {
    ...f.host,
    entry: join(f.directory, 'catalog-publisher.mjs'),
  });
  await runCatalogPublisher(['stop'], f.host);
  await expect(readFile(f.agent)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(JSON.parse(await readFile(join(f.directory, 'connection.json'), 'utf8')).publisherId).toBe(
    id,
  );
});

it('locks both manual and background publication and stores a safe local failure without claiming success', async () => {
  const f = await fixture();
  await runCatalogPublisher(['pair', '--catalog', f.catalog], f.host);
  await runCatalogPublisher(['run'], { ...f.host, locked: false });
  expect(f.output.at(-1)).toEqual({ state: 'busy' });
  expect(f.operations.at(-1)?.args[0]).toBe('lock');
  await writeFile(f.catalog, 'INVALID_PRIVATE_CANARY');
  await expect(runCatalogPublisher(['run'], f.host)).rejects.toMatchObject({
    code: 'invalid_catalog',
  });
  expect(JSON.parse(await readFile(join(f.directory, 'status.json'), 'utf8'))).toMatchObject({
    state: 'error',
    error: 'invalid_catalog',
  });
  expect(JSON.stringify(f.output)).not.toContain('PRIVATE_CANARY');
  await expect(
    runCatalogPublisher(['run'], { ...f.host, execute: () => 'invalid' }),
  ).rejects.toThrow('Local connection unavailable');
});

it('validates paths, arguments, HTTPS and platform before enrollment or installation', async () => {
  const f = await fixture();
  for (const args of [
    [],
    ['bogus'],
    ['run', 'extra'],
    ['pair', '--catalog', 'relative'],
    ['check-source', '--catalog', 'relative'],
    ['pair', '--catalog', f.catalog, '--origin', 'http://localhost'],
    ['pair', '--unknown', 'value'],
    ['pair', '--catalog', f.catalog, '--catalog', f.catalog],
    ['pair', '--catalog'],
  ])
    await expect(runCatalogPublisher(args, f.host)).rejects.toThrow();
  await expect(runCatalogPublisher(['install'], { ...f.host, platform: 'linux' })).rejects.toThrow(
    'currently supports macOS',
  );
  expect(fetch).not.toHaveBeenCalled();
  await runCatalogPublisher(['pair', '--catalog', f.catalog], f.host);
  await writeFile(
    join(f.directory, 'connection.json'),
    JSON.stringify({
      catalog: 'relative',
      origin: 'https://health.example.test',
      publisherId: id,
      code,
    }),
  );
  await expect(runCatalogPublisher(['run'], f.host)).rejects.toThrow('Invalid local connection');
});

it.skipIf(process.platform === 'win32')(
  'executes a local lock wrapper without logging its process arguments or failures',
  async () => {
    const f = await fixture();
    await mkdir(f.directory, { recursive: true });
    const helper = join(f.directory, 'catalog-keychain');
    await writeFile(helper, '#!/bin/sh\nprintf \'{"state":"busy"}\\n\'\n');
    await chmod(helper, 0o700);
    await runCatalogPublisher(['run'], { ...f.host, locked: false, execute: undefined });
    expect(f.output.at(-1)).toEqual({ state: 'busy' });
    await writeFile(helper, '#!/bin/sh\nexit 75\n');
    await runCatalogPublisher(['run'], { ...f.host, locked: false, execute: undefined });
    expect(f.output.at(-1)).toEqual({ state: 'busy' });
    await writeFile(helper, '#!/bin/sh\nexit 1\n');
    await expect(
      runCatalogPublisher(['run'], { ...f.host, locked: false, execute: undefined }),
    ).rejects.toThrow('Local service operation failed');
  },
);
