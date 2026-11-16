import { spawnSync } from 'node:child_process';
import { copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
function run(program, args) {
  const result = spawnSync(program, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Catalog publisher build failed');
}
run('pnpm', [
  '--filter',
  '@app-health/web',
  'exec',
  'vite',
  'build',
  '--config',
  'catalog-publisher.config.ts',
]);
await copyFile(
  resolve(root, 'apps/catalog-publisher/src/catalog-keychain.swift'),
  resolve(root, 'dist/catalog-publisher/catalog-keychain.swift'),
);
if (process.platform === 'darwin') {
  run('/usr/bin/swiftc', [
    resolve(root, 'dist/catalog-publisher/catalog-keychain.swift'),
    '-o',
    resolve(root, 'dist/catalog-publisher/catalog-keychain'),
  ]);
  run('/usr/bin/codesign', [
    '--force',
    '--sign',
    '-',
    '--identifier',
    'com.sassmaker.app-health.catalog-keychain',
    resolve(root, 'dist/catalog-publisher/catalog-keychain'),
  ]);
}
