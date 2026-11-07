import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { buildOperationsSnapshot } from './lib/operations-normalize.mjs';
import { readOperationsSnapshot } from '../apps/web/src/lib/operations-model.ts';

const options = new Set([
  'catalog',
  'github',
  'deployments',
  'workspace-state',
  'probe-results',
  'site-health',
  'security',
  'output',
]);
function argumentsFor(values) {
  const args = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]?.replace(/^--/, '');
    if (!options.has(key) || !values[index + 1])
      throw new Error('Expected a supported --option and value');
    args[key] = values[index + 1];
  }
  if (!args.catalog || !args.output) throw new Error('--catalog and --output are required');
  return args;
}
async function readInput(path) {
  if (!path) return undefined;
  const body = await readFile(path, 'utf8');
  if (Buffer.byteLength(body) > 20 * 1024 * 1024) throw new Error('Source input exceeds 20 MiB');
  return JSON.parse(body);
}
const optionalSource = (read) => read().catch(() => ({ unavailable: true }));
async function readSiteHealth(origin) {
  if (!origin) return undefined;
  const url = new URL(origin);
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Site Health source must be a credential-free loopback origin');
  const read = async (path) => {
    const response = await globalThis.fetch(new URL(path, url), {
      signal: globalThis.AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Site Health read returned ${response.status}`);
    const body = await response.text();
    if (Buffer.byteLength(body) > 10 * 1024 * 1024)
      throw new Error('Site Health response exceeds 10 MiB');
    return JSON.parse(body);
  };
  const [evidence, readiness] = await Promise.all([
    read('/v1/evidence-status'),
    read('/v1/readiness'),
  ]);
  return { evidence, readiness };
}
async function main() {
  const args = argumentsFor(process.argv.slice(2));
  const [catalog, github, deployments, workspace, probes, siteHealth, security] = await Promise.all(
    [
      readInput(args.catalog),
      optionalSource(() => readInput(args.github)),
      optionalSource(() => readInput(args.deployments)),
      optionalSource(() => readInput(args['workspace-state'])),
      optionalSource(() => readInput(args['probe-results'])),
      optionalSource(() => readSiteHealth(args['site-health'])),
      optionalSource(() => readInput(args.security)),
    ],
  );
  const snapshot = readOperationsSnapshot(
    buildOperationsSnapshot({
      catalog,
      github,
      deployments,
      workspace,
      probes,
      siteHealth,
      security,
    }),
  );
  const output = resolve(args.output);
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (output === repo || output.startsWith(repo + '/'))
    throw new Error('Private snapshots must stay outside the source checkout');
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const temporary = `${output}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, output);
  process.stdout.write(
    JSON.stringify({
      projects: snapshot.projects.length,
      families: snapshot.families.length,
      connectedFamilies: snapshot.families.filter((family) => family.connected).length,
      feeds: snapshot.feeds.length,
      observations: snapshot.observations.length,
    }) + '\n',
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    process.stderr.write(
      'Operations collection failed. Check source availability and input contracts.\n',
    );
    process.exitCode = 1;
  });
