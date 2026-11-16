import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workerPackageArguments, workerUploadArguments, packageWorker } from './package-worker.mjs';
const sha = 'a'.repeat(40);
test('deploy and staged upload bind the same immutable source definition, tag and output', () => {
  for (const mode of ['deploy', 'upload']) {
    const args = workerPackageArguments(mode, sha, [
      '--dry-run',
      '--message',
      'literal $() `text`',
    ]);
    assert.equal(args[args.indexOf('--define') + 1], `__APP_HEALTH_BUILD_SHA__:"${sha}"`);
    assert.equal(args[args.indexOf('--tag') + 1], sha);
    assert.equal(args[args.indexOf('--config') + 1], 'wrangler.jsonc');
    assert.equal(args[args.indexOf('--outdir') + 1], '../../.release/worker');
    assert.equal(args.at(-1), 'literal $() `text`');
    assert.deepEqual(
      args.slice(0, mode === 'deploy' ? 1 : 2),
      mode === 'deploy' ? ['deploy'] : ['versions', 'upload'],
    );
  }
});
test('packaging rejects unreviewed source replacement and target/config overrides', () => {
  for (const args of [
    ['--define', 'other'],
    ['--define=other'],
    ['--tag', sha],
    ['--config', 'other'],
    ['--env-file', 'private'],
    ['--no-bundle'],
    ['--outdir'],
  ])
    assert.throws(() => workerPackageArguments('deploy', sha, args));
  assert.throws(() => workerPackageArguments('deploy', 'unknown'));
  assert.throws(() => workerPackageArguments('other', sha));
});

test('publication reuses the prepared Worker instead of rebuilding changed source', () => {
  for (const mode of ['deploy', 'upload']) {
    const prepared = workerPackageArguments(mode, sha, [
      '--outdir',
      'fixture',
      '--message',
      'reviewed',
    ]);
    const upload = workerUploadArguments(mode, prepared, '/reviewed/analytics-entry.js');
    assert(upload.includes('--no-bundle'));
    assert(upload.includes('/reviewed/analytics-entry.js'));
    assert(!upload.includes('--define'));
    assert(!upload.includes('--outdir'));
    assert.equal(upload[upload.indexOf('--tag') + 1], sha);
    assert.equal(upload[upload.indexOf('--config') + 1], 'wrangler.jsonc');
  }
});

async function packageFixture(run) {
  const scratch = await mkdtemp(join(tmpdir(), 'worker-package-test-'));
  const root = join(scratch, 'repo'),
    bin = join(scratch, 'bin');
  const previousPath = process.env.PATH,
    previousMutation = process.env.APP_HEALTH_PACKAGE_TEST_MUTATION;
  try {
    await mkdir(join(root, 'apps/worker'), { recursive: true });
    await mkdir(bin);
    await writeFile(join(root, '.gitignore'), '/.release/\n');
    await writeFile(join(root, 'README.md'), 'reviewed source\n');
    for (const args of [
      ['init', '--quiet'],
      ['config', 'user.name', 'Package fixture'],
      ['config', 'user.email', 'package@example.invalid'],
      ['add', '.'],
      ['commit', '--quiet', '-m', 'Reviewed fixture'],
    ])
      execFileSync('git', args, { cwd: root });
    const mock = join(bin, 'pnpm');
    await writeFile(
      mock,
      `#!/usr/bin/env node
const fs=require('node:fs');const path=require('node:path');
const root=process.cwd(),args=process.argv.slice(2),release=path.join(root,'.release');fs.mkdirSync(release,{recursive:true});
const log=path.join(release,'calls.json');const calls=fs.existsSync(log)?JSON.parse(fs.readFileSync(log)):[];calls.push(args);fs.writeFileSync(log,JSON.stringify(calls));
if(args.includes('--dry-run')){const directory=path.resolve(root,'apps/worker',args[args.indexOf('--outdir')+1]);fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'analytics-entry.js'),'export default {};');if(process.env.APP_HEALTH_PACKAGE_TEST_MUTATION)fs.writeFileSync(path.join(root,'README.md'),'changed during packaging');}
`,
    );
    await chmod(mock, 0o755);
    process.env.PATH = `${bin}:${previousPath}`;
    await run(root);
  } finally {
    process.env.PATH = previousPath;
    if (previousMutation === undefined) delete process.env.APP_HEALTH_PACKAGE_TEST_MUTATION;
    else process.env.APP_HEALTH_PACKAGE_TEST_MUTATION = previousMutation;
    await rm(scratch, { recursive: true, force: true });
  }
}

test('records source and artifact checksums and uploads only the prepared bytes', async () => {
  await packageFixture(async (root) => {
    await packageWorker(root, 'upload', []);
    const calls = JSON.parse(await readFile(join(root, '.release/calls.json'), 'utf8'));
    assert.equal(calls.length, 2);
    assert(calls[0].includes('--dry-run'));
    assert(calls[1].includes('--no-bundle'));
    const receipt = JSON.parse(await readFile(join(root, '.release/worker-package.json'), 'utf8'));
    const source = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    assert.equal(receipt.source_sha, source);
    assert.equal((await readFile(join(root, '.release/source-sha.txt'), 'utf8')).trim(), source);
    assert.equal(receipt.artifacts.length, 1);
    assert.match(receipt.artifacts[0].sha256, /^[a-f0-9]{64}$/);
  });
});

test('rejects a dirty checkout before invoking packaging', async () => {
  await packageFixture(async (root) => {
    await writeFile(join(root, 'README.md'), 'unreviewed source');
    await assert.rejects(packageWorker(root, 'deploy', []), /clean committed source/);
    await assert.rejects(readFile(join(root, '.release/calls.json')), /ENOENT/);
  });
});

test('detects source changes after preparation and never publishes them', async () => {
  await packageFixture(async (root) => {
    process.env.APP_HEALTH_PACKAGE_TEST_MUTATION = '1';
    await assert.rejects(
      packageWorker(root, 'deploy', []),
      /clean committed source|source changed/,
    );
    const calls = JSON.parse(await readFile(join(root, '.release/calls.json'), 'utf8'));
    assert.equal(calls.length, 1);
    assert(calls[0].includes('--dry-run'));
    assert(!calls[0].includes('--no-bundle'));
  });
});

test('allows generated rendered evidence without accepting dirty source inputs', async () => {
  await packageFixture(async (root) => {
    await mkdir(join(root, '.fleet/evidence/catalog'), { recursive: true });
    await writeFile(join(root, '.fleet/evidence/catalog/status.png'), 'generated rendered output');
    await packageWorker(root, 'deploy', ['--dry-run']);
    const calls = JSON.parse(await readFile(join(root, '.release/calls.json'), 'utf8'));
    assert.equal(calls.length, 1);
  });
});

test('rejects a nonempty output directory before packaging and preserves unknown files', async () => {
  await packageFixture(async (root) => {
    const directory = join(root, '.release/worker');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'unknown-module.js'), 'preserved previous output');
    await assert.rejects(packageWorker(root, 'deploy', ['--dry-run']), /empty output directory/);
    assert.equal(
      await readFile(join(directory, 'unknown-module.js'), 'utf8'),
      'preserved previous output',
    );
    await assert.rejects(readFile(join(root, '.release/calls.json')), /ENOENT/);
    await assert.rejects(readFile(join(root, '.release/worker-package.json')), /ENOENT/);
  });
});
