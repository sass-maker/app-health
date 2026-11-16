import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import {
  enrollPublisher,
  checkCatalogSource,
  publishOnce,
  PublisherFailure,
  type PublisherConfig,
} from './catalog-publisher.js';

const label = 'com.sassmaker.app-health.catalog-publisher';
type PublisherHost = {
  home: string;
  platform: string;
  node: string;
  entry: string;
  uid: number;
  locked: boolean;
  execute: (program: string, args: string[], input?: string) => string;
  output: (value: unknown) => void;
};
function localFailureHint(code: string) {
  if (code === 'install_required')
    return 'Run the publisher install command first, then pair this Mac.';
  if (['connection_inactive', 'credential_unavailable', 'configuration_unavailable'].includes(code))
    return 'Run pair, then approve the connection in App Health.';
  return undefined;
}
function command(program: string, args: string[], input?: string) {
  const result = spawnSync(program, args, {
    input,
    encoding: 'utf8',
    timeout: 120_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status === 75 && args[0] === 'lock') return JSON.stringify({ state: 'busy' });
  if (result.status !== 0) {
    if (args[0] === 'lock') {
      try {
        const failure = JSON.parse(result.stdout) as { state?: unknown; error?: unknown };
        if (
          failure.state === 'error' &&
          typeof failure.error === 'string' &&
          [
            'invalid_catalog',
            'source_unavailable',
            'service_unavailable',
            'review_required',
            'conflict',
            'install_required',
            'configuration_unavailable',
            'credential_unavailable',
            'connection_inactive',
          ].includes(failure.error)
        )
          throw new PublisherFailure(
            failure.error as ConstructorParameters<typeof PublisherFailure>[0],
          );
      } catch (error) {
        if (error instanceof PublisherFailure)
          throw error; /* Other child output is never echoed. */
      }
    }
    throw new Error('Local service operation failed');
  }
  return result.stdout;
}
function options(args: string[]) {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!['--catalog', '--origin', '--label'].includes(key ?? '') || !value || result.has(key!))
      throw new Error('Invalid arguments');
    result.set(key!, value);
  }
  return result;
}
function origin(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('Use the HTTPS App Health origin');
  return url.origin;
}
function xml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, path);
}

class LocalPublisher {
  private readonly host: PublisherHost;
  private readonly directory: string;
  private readonly configPath: string;
  private readonly launchAgent: string;
  private readonly installedEntry: string;
  private readonly helper: string;
  constructor(host: PublisherHost) {
    this.host = host;
    this.directory = join(host.home, 'Library/Application Support/App Health/Catalog Publisher');
    this.configPath = join(this.directory, 'connection.json');
    this.launchAgent = join(host.home, 'Library/LaunchAgents', `${label}.plist`);
    this.installedEntry = join(this.directory, 'catalog-publisher.mjs');
    this.helper = join(this.directory, 'catalog-keychain');
  }
  async main(argv: string[]) {
    const [action, ...args] = argv;
    if (this.host.platform !== 'darwin')
      throw new Error('The background publisher currently supports macOS');
    if ((action === 'pair' || action === 'run') && !this.host.locked) {
      await this.requireInstalled();
      this.host.output(
        JSON.parse(
          this.host.execute(this.helper, [
            'lock',
            join(this.directory, 'run.lock'),
            this.host.node,
            this.host.entry,
            action,
            ...args,
          ]),
        ),
      );
      return;
    }
    if (action === 'pair') return this.pair(args);
    if (action === 'check-source') {
      const source = options(args).get('--catalog') ?? '';
      if (!isAbsolute(source)) throw new Error('Provide an absolute canonical catalog path');
      this.host.output(await checkCatalogSource(source));
      return;
    }
    if (args.length) throw new Error('Unexpected arguments');
    if (action === 'install') {
      await this.install();
      this.host.output({ state: 'installed', interval_seconds: 60 });
      return;
    }
    if (action === 'run') return this.run();
    if (action === 'stop') {
      await this.stop();
      this.host.output({
        state: 'stopped',
        connection: 'retained; revoke it in App Health to remove access',
      });
      return;
    }
    if (action === 'status') {
      this.host.output(JSON.parse(await readFile(join(this.directory, 'status.json'), 'utf8')));
      return;
    }
    throw new Error('Use install, pair --catalog /absolute/projects.json, run, status, or stop');
  }
  private async requireInstalled() {
    try {
      await access(this.helper);
    } catch {
      throw new PublisherFailure('install_required');
    }
  }
  private async config() {
    const value = JSON.parse(await readFile(this.configPath, 'utf8')) as PublisherConfig;
    origin(value.origin);
    if (
      !isAbsolute(value.catalog) ||
      !/^[a-f0-9-]{36}$/.test(value.publisherId) ||
      !/^[A-F0-9]{12}$/.test(value.code)
    )
      throw new Error('Invalid local connection');
    return value;
  }
  private gui() {
    return `gui/${this.host.uid}`;
  }
  private async stop() {
    try {
      this.host.execute('/bin/launchctl', ['bootout', `${this.gui()}/${label}`]);
    } catch {
      /* An absent launch agent is already stopped. */
    }
    await unlink(this.launchAgent).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  private async install() {
    const source = dirname(this.host.entry);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.stop();
    if (this.host.entry !== this.installedEntry) {
      await copyFile(this.host.entry, this.installedEntry);
      await copyFile(join(source, 'catalog-keychain'), this.helper);
      await chmod(this.helper, 0o700);
    }
    await mkdir(dirname(this.launchAgent), { recursive: true });
    await writeFile(
      this.launchAgent,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(this.host.node)}</string><string>${xml(this.installedEntry)}</string><string>run</string></array>
<key>RunAtLoad</key><true/><key>StartInterval</key><integer>60</integer>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(join(this.directory, 'service.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(this.directory, 'service-error.log'))}</string>
</dict></plist>`,
      { mode: 0o600 },
    );
    this.host.execute('/bin/launchctl', ['bootstrap', this.gui(), this.launchAgent]);
  }
  private async pair(args: string[]) {
    const input = options(args);
    const catalog = input.get('--catalog') ?? '';
    const endpoint = origin(input.get('--origin') ?? 'https://health.sassmaker.com');
    if (!isAbsolute(catalog)) throw new Error('Provide an absolute canonical catalog path');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const enrollment = await enrollPublisher(
      endpoint,
      input.get('--label') ?? 'Fleet catalog on this Mac',
    );
    this.host.execute(this.helper, ['put', enrollment.publisher_id], enrollment.secret);
    await atomicJson(this.configPath, {
      origin: endpoint,
      catalog,
      publisherId: enrollment.publisher_id,
      code: enrollment.code,
    });
    this.host.output({
      state: 'pending',
      code: enrollment.code,
      approval_url: `${endpoint}/app`,
      expires_at: enrollment.expires_at,
    });
  }
  private async connectionCredential() {
    let connection: PublisherConfig;
    try {
      connection = await this.config();
    } catch {
      throw new PublisherFailure('configuration_unavailable');
    }
    try {
      const secret = this.host.execute(this.helper, ['get', connection.publisherId]);
      if (!/^ahcp_[a-f0-9]{64}$/.test(secret)) throw new Error('Unavailable');
      return { connection, secret };
    } catch {
      throw new PublisherFailure('credential_unavailable');
    }
  }
  private async run() {
    try {
      const { connection, secret } = await this.connectionCredential();
      const result = await publishOnce(connection, secret);
      await atomicJson(join(this.directory, 'status.json'), { ...result, checked_at: Date.now() });
      this.host.output(result);
    } catch (error) {
      const code = error instanceof PublisherFailure ? error.code : 'service_unavailable';
      const hint = localFailureHint(code);
      await atomicJson(join(this.directory, 'status.json'), {
        state: 'error',
        error: code,
        hint,
        checked_at: Date.now(),
      });
      throw error;
    }
  }
}

export async function runCatalogPublisher(argv: string[], overrides: Partial<PublisherHost> = {}) {
  const host: PublisherHost = {
    home: homedir(),
    platform: process.platform,
    node: process.execPath,
    entry: fileURLToPath(import.meta.url),
    uid: process.getuid?.() ?? 0,
    locked: process.env.APP_HEALTH_CATALOG_LOCKED === '1',
    output: (value) => process.stdout.write(`${JSON.stringify(value)}\n`),
    ...overrides,
    execute: overrides.execute ?? command,
  };
  await new LocalPublisher(host).main(argv);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCatalogPublisher(process.argv.slice(2)).catch((error: unknown) => {
    process.stdout.write(
      `${JSON.stringify({ state: 'error', error: error instanceof PublisherFailure ? error.code : 'local_service_unavailable', message: error instanceof PublisherFailure ? localFailureHint(error.code) : undefined })}\n`,
    );
    process.exitCode = 1;
  });
}
