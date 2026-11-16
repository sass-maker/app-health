import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

export function workerPackageArguments(mode, sha, args = []) {
  if (!['deploy', 'upload'].includes(mode) || !/^[a-f0-9]{40}$/.test(sha))
    throw new Error('Invalid Worker package identity');
  const accepted = [];
  let outdir = '../../.release/worker';
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (['--dry-run', '--upload-source-maps', '--strict'].includes(argument))
      accepted.push(argument);
    else if (
      ['--outdir', '--message'].includes(argument) &&
      args[index + 1] &&
      !args[index + 1].startsWith('--')
    ) {
      const value = args[++index];
      if (argument === '--outdir') outdir = value;
      else accepted.push(argument, value);
    } else throw new Error(`Unsupported Worker package argument: ${argument}`);
  }
  return [
    ...(mode === 'deploy' ? ['deploy'] : ['versions', 'upload']),
    '--env',
    '',
    '--define',
    `__APP_HEALTH_BUILD_SHA__:${JSON.stringify(sha)}`,
    '--tag',
    sha,
    '--outdir',
    outdir,
    ...accepted,
  ];
}

function sourceState(root) {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const changed = execFileSync('git', ['diff', '--name-only', '-z', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  });
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
  });
  const dirtySource = `${changed}${untracked}`
    .split('\0')
    .some((file) => file && !file.startsWith('.fleet/evidence/'));
  if (!/^[a-f0-9]{40}$/.test(sha) || dirtySource)
    throw new Error('Worker packaging requires clean committed source inputs');
  return sha;
}

async function artifactChecksums(directory) {
  const files = [];
  async function visit(relative) {
    for (const entry of (await readdir(join(directory, relative), { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const name = join(relative, entry.name);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) {
        const bytes = await readFile(join(directory, name));
        files.push({
          file: name,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      } else throw new Error('Unexpected Worker package artifact');
    }
  }
  await visit('');
  if (!files.length) throw new Error('Worker package has no artifacts');
  return files;
}

export function workerUploadArguments(mode, preparedArgs, entry) {
  const commandLength = mode === 'deploy' ? 1 : 2;
  const args = preparedArgs.slice(0, commandLength);
  args.push(entry, '--no-bundle');
  for (let index = commandLength; index < preparedArgs.length; index++) {
    const flag = preparedArgs[index];
    if (flag === '--define' || flag === '--outdir') {
      index++;
      continue;
    }
    if (flag !== '--dry-run') args.push(flag);
  }
  return args;
}

export async function packageWorker(root, mode, args) {
  const sha = sourceState(root);
  const argv = workerPackageArguments(mode, sha, args);
  const run = (flags) => {
    const result = spawnSync(
      'pnpm',
      ['--filter', '@app-health/worker', 'exec', 'wrangler', ...flags],
      {
        cwd: root,
        stdio: 'inherit',
        shell: false,
      },
    );
    if (result.error || result.status !== 0)
      throw result.error ?? new Error('Worker packaging failed');
  };
  run(argv.includes('--dry-run') ? argv : [...argv, '--dry-run']);
  if (sourceState(root) !== sha) throw new Error('Worker source changed during packaging');
  const outdir = argv[argv.indexOf('--outdir') + 1];
  const directory = resolve(root, 'apps/worker', outdir);
  const artifacts = await artifactChecksums(directory);
  const entry = join(directory, 'analytics-entry.js');
  if (!artifacts.some((file) => file.file === 'analytics-entry.js'))
    throw new Error('Worker entry artifact is missing');
  await mkdir(join(root, '.release'), { recursive: true });
  await writeFile(join(root, '.release/source-sha.txt'), `${sha}\n`);
  await writeFile(
    join(root, '.release/worker-package.json'),
    `${JSON.stringify({ source_sha: sha, artifacts }, null, 2)}\n`,
  );
  if (!argv.includes('--dry-run')) {
    if (sourceState(root) !== sha) throw new Error('Worker source changed before upload');
    run(workerUploadArguments(mode, argv, entry));
    if (JSON.stringify(await artifactChecksums(directory)) !== JSON.stringify(artifacts))
      throw new Error('Worker artifacts changed during upload');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  await packageWorker(root, process.argv[2], process.argv.slice(3));
}
