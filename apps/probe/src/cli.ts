#!/usr/bin/env node
// Journey probe CLI. Runs one probe pass and exits; a scheduler (launchd on the
// owner's machine for the India/local vantage, or any non-Cloudflare runner)
// invokes it every few minutes. Without APP_HEALTH_INGEST_KEY it is a dry run:
// results and the logs it would send are printed, and no state is written.
//
//   node apps/probe/src/cli.ts --location india-home \
//     [--config apps/probe/journeys.json] [--state ~/.app-health-probe/state.json] \
//     [--interval 300]

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeliver, DEFAULT_LOGS_URL, type ProbeLog } from './emit.ts';
import { measureHttp } from './measure.ts';
import { emptyState, runProbes, type ProbeState } from './run.ts';
import { parseSpec } from './spec.ts';

export interface CliOptions {
  location: string;
  config: string;
  state?: string;
  intervalSeconds: number;
}

const DEFAULT_CONFIG = resolve(dirname(fileURLToPath(import.meta.url)), '../journeys.json');
const LOCATION_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

const FLAGS = new Set(['--location', '--config', '--state', '--interval']);

function flagValues(argv: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index] ?? '';
    const value = argv[index + 1];
    if (!FLAGS.has(flag) || value === undefined)
      throw new Error(`unknown or incomplete argument ${flag}`);
    values.set(flag, value);
  }
  return values;
}

export function parseArgs(argv: string[]): CliOptions {
  const values = flagValues(argv);
  const location = values.get('--location') ?? '';
  if (!LOCATION_PATTERN.test(location))
    throw new Error('--location must be a lowercase id such as india-home');
  const interval = Number(values.get('--interval') ?? 300);
  if (!Number.isInteger(interval) || interval < 60 || interval > 86_400)
    throw new Error('--interval must be 60 to 86400 seconds');
  return {
    location,
    config: values.get('--config') ?? DEFAULT_CONFIG,
    state: values.get('--state'),
    intervalSeconds: interval,
  };
}

export async function readState(path: string | undefined): Promise<ProbeState> {
  if (!path) return emptyState();
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as ProbeState;
    if (parsed.schema_version !== 1 || typeof parsed.journeys !== 'object') return emptyState();
    return { ...parsed, pending: Array.isArray(parsed.pending) ? parsed.pending : [] };
  } catch {
    return emptyState();
  }
}

export async function writeState(path: string, state: ProbeState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const options = parseArgs(argv);
  const spec = parseSpec(JSON.parse(await readFile(options.config, 'utf8')));
  const key = env.APP_HEALTH_INGEST_KEY?.trim();
  const sent: ProbeLog[] = [];
  const deliver = key
    ? createDeliver(
        { key, url: env.APP_HEALTH_LOGS_URL ?? DEFAULT_LOGS_URL, timeoutMs: 10_000 },
        randomUUID,
      )
    : async (logs: ProbeLog[]) => (sent.push(...logs), true);
  const previous = await readState(options.state);
  const { state, summary } = await runProbes(
    spec,
    previous,
    {
      location: options.location,
      intervalSeconds: options.intervalSeconds,
      userAgent: 'AppHealthJourneyProbe/1 (+https://health.sassmaker.com)',
    },
    { measure: measureHttp, deliver, now: Date.now, uuid: randomUUID },
  );
  if (key && options.state) await writeState(options.state, state);
  const output = key ? summary : { ...summary, dry_run: true, would_send: sent };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(2);
    },
  );
}
