import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOperationsSnapshot } from './lib/operations-normalize.mjs';

const now = '2026-11-07T13:00:00Z';
const catalog = {
  projects: [
    {
      id: 'alpha',
      name: 'Alpha',
      lifecycle: { status: 'active' },
      purpose: { audience: 'public' },
      classification: { kind: 'product' },
      repositories: { url: 'https://github.com/example/alpha', localPath: 'alpha' },
    },
    {
      id: 'internal',
      name: 'Internal',
      lifecycle: { status: 'active' },
      purpose: { audience: 'internal' },
      classification: { kind: 'platform' },
      repositories: { url: 'https://github.com/example/internal', localPath: 'internal' },
    },
    { id: 'retired', name: 'Retired', lifecycle: { status: 'inactive' } },
  ],
};
const run = (values = {}) => ({
  id: 1,
  sha: 'head',
  branch: 'main',
  status: 'completed',
  conclusion: 'failure',
  updatedAt: now,
  url: 'https://github.com/example/alpha/actions/runs/1',
  ...values,
});
const workflow = (values = {}) => ({
  id: 1,
  name: 'CI',
  state: 'active',
  triggers: ['push'],
  schedules: [],
  defaultBranch: run(),
  ...values,
});
const github = (workflows, extra = {}) => ({
  completedAt: now,
  repositories: [{ repository: 'example/alpha', branch: 'main', sha: 'head', workflows, ...extra }],
});

test('counts canonical active scope and keeps absent integrations unconnected', () => {
  const result = buildOperationsSnapshot({ catalog, now });
  assert.equal(result.projects.length, 2);
  assert.equal(result.projects.filter((project) => project.audience === 'public').length, 1);
  assert.equal(result.families.filter((family) => family.connected).length, 0);
  assert.equal(result.feeds.length, 0);
  assert.equal(result.observations.length, 0);
});
test('rejects incomplete active classification instead of assigning public/product', () => {
  assert.throws(
    () =>
      buildOperationsSnapshot({
        catalog: {
          projects: [{ id: 'unknown', name: 'Unknown', lifecycle: { status: 'active' } }],
        },
        now,
      }),
    /classification/,
  );
});
test('keeps cancelled and old main checks unknown while current generated failures are actionable', () => {
  const result = buildOperationsSnapshot({
    catalog,
    now,
    github: github([
      workflow({ id: 1, defaultBranch: run({ conclusion: 'cancelled' }) }),
      workflow({ id: 2, defaultBranch: run({ sha: 'old' }) }),
      workflow({ id: 3, generated: true, defaultBranch: null, latest: run() }),
    ]),
  });
  assert.deepEqual(
    result.feeds.map((feed) => feed.health),
    ['unknown', 'unknown', 'failing'],
  );
  assert.deepEqual(
    result.observations.map((entry) => entry.severity),
    ['info', 'info', 'error'],
  );
});
test('does not replace a failed schedule with a successful manual run', () => {
  const result = buildOperationsSnapshot({
    catalog,
    now,
    github: github([
      workflow({
        triggers: ['schedule'],
        schedules: ['0 9 * * 1'],
        schedule: run(),
        latest: run({ conclusion: 'success' }),
        defaultBranch: null,
      }),
    ]),
  });
  assert.equal(result.feeds[0].familyId, 'github-schedules');
  assert.equal(result.feeds[0].health, 'failing');
  assert.equal(result.observations[0].scope, 'schedule');
});
test('deduplicates identities, preserves collection age, and excludes unrelated repositories', () => {
  const input = github([workflow(), workflow()]);
  input.completedAt = '2026-11-01T13:00:00Z';
  input.repositories.push({ repository: 'unrelated/repository', workflows: [workflow()] });
  const result = buildOperationsSnapshot({ catalog, now, github: input });
  assert.equal(result.feeds.length, 1);
  assert.equal(result.observations.length, 1);
  assert.equal(result.feeds[0].freshness, 'stale');
  assert.equal(result.feeds[0].collectedAt, '2026-11-01T13:00:00.000Z');
});
test('a deployment SHA difference remains information and an unknown deployment time stays unknown', () => {
  const result = buildOperationsSnapshot({
    catalog,
    now,
    deployments: {
      generatedAt: now,
      targets: [
        {
          project: 'alpha',
          target: 'api',
          kind: 'Worker',
          deployed: 'old',
          currentMain: 'head',
          currentParity: 'different',
          observedAt: null,
        },
      ],
    },
  });
  assert.equal(result.feeds[0].health, 'unknown');
  assert.equal(result.feeds[0].observedAt, null);
  assert.equal(result.observations[0].severity, 'info');
});
test('unavailable security queries remain gaps and available alerts retain untriaged scope', () => {
  const result = buildOperationsSnapshot({
    catalog,
    now,
    security: {
      generatedAt: now,
      repositories: [
        {
          repository: 'example/alpha',
          observedAt: now,
          dependabot: { status: 'unavailable', httpStatus: 403 },
          codeScanning: {
            status: 'available',
            alerts: [
              {
                id: 5,
                title: 'Review tainted input',
                severity: 'high',
                url: 'javascript:alert(1)',
              },
            ],
          },
        },
      ],
    },
  });
  assert.equal(result.feeds[0].health, 'unavailable');
  assert.match(result.feeds[0].summary, /unknown/);
  assert.equal(result.families.find((family) => family.id === 'github-security').connected, true);
  assert.match(result.observations[1].detail, /Untriaged/);
  assert.equal(result.observations[1].evidenceUrl, undefined);
});
test('an entirely unavailable input is represented without claiming a connected source', () => {
  const result = buildOperationsSnapshot({ catalog, now, github: { unavailable: true } });
  assert.equal(result.families.filter((family) => family.connected).length, 0);
  assert.equal(result.feeds.length, 2);
  assert.ok(result.feeds.every((feed) => feed.health === 'unavailable'));
});
test('idle workspace age does not become a product failure or automatic repair', () => {
  const result = buildOperationsSnapshot({
    catalog,
    now,
    workspace: {
      generatedAt: now,
      workspaces: [
        {
          id: 'old-writer',
          state: 'active',
          repo: '/Users/operator/fleet/alpha',
          heartbeatAt: '2026-10-01T13:00:00Z',
          task: 'Read provider state',
          lastExitCode: 0,
        },
      ],
    },
  });
  assert.equal(result.feeds[0].health, 'unknown');
  assert.equal(result.feeds[0].freshness, 'current');
  assert.equal(result.observations.length, 0);
  assert.equal(result.families.find((family) => family.id === 'repairs').connected, false);
  assert.doesNotMatch(JSON.stringify(result), /\/Users\//);
});

test('a disabled schedule with manual dispatch has one schedule record, not a duplicate main incident', () => {
  const result = buildOperationsSnapshot({
    catalog,
    now,
    github: github([
      workflow({
        state: 'disabled_manually',
        triggers: ['schedule', 'workflow_dispatch'],
        schedules: ['*/5 * * * *'],
        schedule: run({ conclusion: 'success' }),
        defaultBranch: null,
      }),
    ]),
  });
  assert.equal(result.feeds.length, 1);
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].scope, 'schedule');
});
test('usage null is missing coverage, while a current numeric zero is an observed proxy', () => {
  const make = (id, value, state) => ({
    id,
    name: id,
    evidence: [
      {
        id: 'monthly-browser-proxy',
        source: 'app-health.browser-report',
        value,
        unit: 'browsers',
        observedAt: now,
        measurement: { state },
        gap: 'Not meaningful-use qualification',
      },
    ],
  });
  const result = buildOperationsSnapshot({
    catalog,
    now,
    siteHealth: {
      readiness: {
        generatedAt: now,
        projects: [make('alpha', 0, 'current'), make('internal', null, 'missing')],
      },
    },
  });
  assert.equal(result.feeds[0].health, 'healthy');
  assert.match(result.feeds[0].summary, /^0 browsers/);
  assert.equal(result.feeds[1].health, 'unknown');
  assert.match(result.feeds[1].summary, /not zero use/);
});
