#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { checkShadcnVendor, shadcnVendorPaths } from './shadcn-vendor.mjs';

checkShadcnVendor();

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const productionPaths = [
  'apps/web/src',
  'apps/worker/src',
  'packages/contracts/src',
  'packages/node/src',
  'packages/go',
];

function log(message) {
  process.stdout.write(`${message}\n`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? projectRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    throw new Error(`${command} exited with status ${result.status}`);
  }
  return result;
}

function failRegressions(label, observed, baseline) {
  const regressions = Object.entries(baseline).filter(([key, maximum]) => observed[key] > maximum);
  if (regressions.length > 0) {
    throw new Error(
      regressions
        .map(([key, maximum]) => `${label} ${key} regressed: ${observed[key]} > ${maximum}`)
        .join('\n'),
    );
  }
  if (Object.entries(baseline).some(([key, maximum]) => observed[key] < maximum)) {
    log(`${label} improved; lower the checked-in baseline in the next intentional update.`);
  }
}

function checkMinimums(label, observed, minimums) {
  const regressions = Object.entries(minimums).filter(
    ([key, minimum]) => observed[key] + Number.EPSILON < minimum,
  );
  if (regressions.length > 0) {
    throw new Error(
      regressions
        .map(([key, minimum]) => `${label} ${key} regressed: ${observed[key]} < ${minimum}`)
        .join('\n'),
    );
  }
  if (Object.entries(minimums).some(([key, minimum]) => observed[key] > minimum)) {
    log(`${label} improved; raise the checked-in baseline in the next intentional update.`);
  }
}

function checkGoFormat() {
  const result = run('gofmt', ['-l', 'packages/go', 'examples/go']);
  const files = result.stdout.trim();
  if (files) throw new Error(`Go formatting drift:\n${files}`);
  log('Go format: clean.');
}

function checkGoVet() {
  run('go', ['vet', './...'], { cwd: join(projectRoot, 'packages/go') });
  log('Go vet: clean.');
}

function checkCoverage() {
  const reportRoot = mkdtempSync(join(tmpdir(), 'app-health-coverage-'));
  const surfaces = [
    {
      label: 'Web',
      filter: '@app-health/web',
      minimums: { lines: 88.89, branches: 87.54, functions: 70.17, statements: 88.89 },
    },
    {
      label: 'Worker',
      filter: '@app-health/worker',
      minimums: { lines: 90.43, branches: 81.08, functions: 91.72, statements: 90.43 },
    },
    {
      label: 'Contracts',
      filter: '@app-health/contracts',
      minimums: { lines: 99.17, branches: 91.66, functions: 100, statements: 99.17 },
    },
    {
      label: 'Node SDK',
      filter: '@saas-maker/app-health',
      minimums: { lines: 94.41, branches: 89.95, functions: 100, statements: 94.41 },
    },
  ];

  for (const surface of surfaces) {
    const reportDirectory = join(reportRoot, surface.filter.replaceAll('/', '-'));
    run('pnpm', [
      '--filter',
      surface.filter,
      'exec',
      'vitest',
      'run',
      '--coverage',
      '--coverage.reporter=json-summary',
      `--coverage.reportsDirectory=${reportDirectory}`,
    ]);
    const total = JSON.parse(
      readFileSync(join(reportDirectory, 'coverage-summary.json'), 'utf8'),
    ).total;
    const observed = {
      lines: total.lines.pct,
      branches: total.branches.pct,
      functions: total.functions.pct,
      statements: total.statements.pct,
    };
    log(
      `${surface.label} coverage: ${observed.lines}% lines, ${observed.branches}% branches, ` +
        `${observed.functions}% functions, ${observed.statements}% statements.`,
    );
    checkMinimums(`${surface.label} coverage`, observed, surface.minimums);
  }

  const goProfile = join(reportRoot, 'go.out');
  run('go', ['test', './...', `-coverprofile=${goProfile}`], {
    cwd: join(projectRoot, 'packages/go'),
  });
  const goCoverage = run('go', ['tool', 'cover', `-func=${goProfile}`], {
    cwd: join(projectRoot, 'packages/go'),
  }).stdout;
  const totalMatch = goCoverage.match(/total:\s+\(statements\)\s+([0-9.]+)%/u);
  if (!totalMatch) throw new Error('Could not parse Go coverage total');
  const observed = { statements: Number(totalMatch[1]) };
  log(`Go SDK coverage: ${observed.statements}% statements.`);
  checkMinimums('Go SDK coverage', observed, { statements: 85.6 });
}

function checkComplexity() {
  const result = run('uvx', [
    '--from',
    'lizard==1.23.0',
    'lizard',
    ...productionPaths,
    '-x',
    '**/*.test.*',
    '-x',
    '**/*_test.go',
    '-x',
    '**/*.d.mts',
    ...shadcnVendorPaths.flatMap((path) => ['-x', path]),
    '--csv',
  ]);
  const rows = result.stdout
    .trim()
    .split('\n')
    .map((line) => line.match(/^(\d+),(\d+),(\d+),(\d+),(\d+),/u))
    .filter(Boolean)
    .map((match) => match.slice(1).map(Number));
  const observed = {
    functions: rows.length,
    nloc: rows.reduce((sum, row) => sum + row[0], 0),
    violations: rows.filter((row) => row[1] > 15 || row[4] > 100 || row[3] > 7).length,
    maxCcn: Math.max(...rows.map((row) => row[1])),
    maxLength: Math.max(...rows.map((row) => row[4])),
    maxParams: Math.max(...rows.map((row) => row[3])),
  };
  log(
    `Complexity: ${observed.functions} functions, ${observed.nloc} NLOC, ` +
      `${observed.violations} violations; max CCN ${observed.maxCcn}, ` +
      `max length ${observed.maxLength}, max params ${observed.maxParams}.`,
  );
  // Ratcheted legacy debt: https://github.com/sass-maker/app-health/issues/39
  failRegressions('Complexity', observed, {
    violations: 0,
    maxCcn: 15,
    maxLength: 91,
    maxParams: 6,
  });
}

function checkDuplication() {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'app-health-jscpd-'));
  run('pnpm', [
    'exec',
    'jscpd',
    ...productionPaths,
    '--format',
    'javascript,typescript,tsx,go',
    '--min-lines',
    '8',
    '--min-tokens',
    '60',
    '--mode',
    'strict',
    '--ignore',
    [
      '**/*.test.*',
      '**/*_test.go',
      '**/*.d.mts',
      '**/node_modules/**',
      '**/coverage/**',
      '**/dist/**',
      ...shadcnVendorPaths,
    ].join(','),
    '--reporters',
    'json',
    '--output',
    outputDirectory,
    '--silent',
    '--no-tips',
  ]);
  const observed = JSON.parse(readFileSync(join(outputDirectory, 'jscpd-report.json'), 'utf8'))
    .statistics.total;
  log(
    `Duplication: ${observed.duplicatedLines}/${observed.lines} lines ` +
      `(${observed.percentage.toFixed(4)}%), ${observed.clones} groups across ` +
      `${observed.sources} files.`,
  );
  // Ratcheted legacy debt: https://github.com/sass-maker/app-health/issues/39
  failRegressions('Duplication', observed, {
    clones: 5,
    duplicatedLines: 75,
    percentage: 1.011190508291762,
  });
}

function checkDependencies() {
  const result = run('pnpm', ['audit', '--json'], { allowFailure: true });
  const report = JSON.parse(result.stdout);
  const severe = Object.values(report.advisories ?? {}).filter((advisory) =>
    ['critical', 'high'].includes(advisory.severity),
  );
  const critical = severe.filter((advisory) => advisory.severity === 'critical').length;
  const high = severe.filter((advisory) => advisory.severity === 'high').length;
  log(`Dependencies: ${critical} critical, ${high} high advisories.`);
  if (severe.length > 0) {
    throw new Error(
      `Critical/high advisories: ${severe
        .map((advisory) => advisory.github_advisory_id)
        .join(', ')}`,
    );
  }
}

function countMatches(pattern) {
  const result = run(
    'git',
    [
      'grep',
      '-n',
      '-E',
      pattern,
      '--',
      ...productionPaths,
      ':(exclude)**/*.test.*',
      ':(exclude)**/*_test.go',
    ],
    { allowFailure: true },
  );
  return result.stdout.trim() ? result.stdout.trim().split('\n') : [];
}

function checkSuppressions() {
  const matches = countMatches(
    '(^|[[:space:]])(//|/\\*)[[:space:]]*(eslint-disable|@ts-ignore|@ts-expect-error|istanbul ignore|c8 ignore|nolint)',
  );
  log(`Suppressions: ${matches.length} inline directives.`);
  if (matches.length > 0) throw new Error(`Unjustified suppressions:\n${matches.join('\n')}`);
}

function checkHygiene() {
  const conflictMarkers = run(
    'git',
    ['grep', '-n', '-E', '^(<<<<<<<|=======|>>>>>>>)', '--', '.'],
    { allowFailure: true },
  ).stdout.trim();
  if (conflictMarkers) throw new Error(`Conflict markers:\n${conflictMarkers}`);
  const todos = countMatches('TODO|FIXME');
  if (todos.length > 0) throw new Error(`Untracked TODO/FIXME markers:\n${todos.join('\n')}`);
  run('git', ['diff', '--check', 'HEAD', '--', '.']);
  log('Repository hygiene: clean.');
}

const checks = {
  complexity: checkComplexity,
  coverage: checkCoverage,
  dependencies: checkDependencies,
  duplication: checkDuplication,
  'go-format': checkGoFormat,
  'go-vet': checkGoVet,
  hygiene: checkHygiene,
  suppressions: checkSuppressions,
};
const selected = process.argv[2];

if (!Object.hasOwn(checks, selected)) {
  process.stderr.write(`Usage: check-code-health.mjs <${Object.keys(checks).join('|')}>\n`);
  process.exit(2);
}

try {
  checks[selected]();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
