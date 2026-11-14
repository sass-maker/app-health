import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import type { MonitoringPolicy, MonitoringReport } from '@app-health/contracts';

const policy: MonitoringPolicy = process.env.APP_HEALTH_MONITORING_POLICY
  ? JSON.parse(readFileSync(process.env.APP_HEALTH_MONITORING_POLICY, 'utf8'))
  : {
      schema_version: 1,
      projects: Array.from({ length: 40 }, (_, i) => ({
        catalog_id: `project-${i}`,
        name: `Project ${i + 1}`,
        scope: i === 38 ? 'local' : i === 39 ? 'private' : 'public',
        reason:
          i === 38
            ? 'Local service only.'
            : i === 39
              ? 'Private workflow remains unobserved.'
              : null,
        journeys: i >= 38 ? [] : ['home'],
      })),
    };
const evidence =
  process.env.APP_HEALTH_EVIDENCE_DIRECTORY ??
  fileURLToPath(new URL('../../../.fleet/evidence/monitoring/', import.meta.url));
const now = Date.now();
const report: MonitoringReport = {
  schema_version: 1,
  generated_at: now,
  policy_updated_at: now,
  projects: policy.projects.map((project, index) => ({
    ...project,
    app_id: `qa-${project.catalog_id}`,
    environment_id: `qa-${project.catalog_id}-production`,
    state:
      project.scope !== 'public'
        ? project.scope
        : index === 0
          ? 'failing'
          : index === 1
            ? 'stale'
            : index === 2
              ? 'missing'
              : 'healthy',
    checks: project.journeys.map((journey) => ({
      journey,
      freshness: index === 1 ? 'stale' : index === 2 ? 'missing' : 'fresh',
      health: index === 1 || index === 2 ? null : index === 0 ? 'failing' : 'healthy',
      observations:
        index === 2
          ? []
          : [
              {
                location: 'cloudflare-hourly',
                last_seen_at: now - (index === 1 ? 14400000 : 120000),
                interval_seconds: 3600,
                freshness: index === 1 ? 'stale' : 'fresh',
                health: index === 1 ? null : index === 0 ? 'failing' : 'healthy',
                failure: index === 0 ? 'timeout' : null,
                total_ms: index === 0 ? 8000 : 143,
              },
            ],
    })),
  })),
};

for (const width of [390, 768, 1440]) {
  test(`all40 monitoring states and roster import at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const live = { measured_at: now, ttl_ms: 45000, total: 0, projects: [] };
    await page.route('**/v1/account/config', (route) => route.fulfill({ json: { google: true } }));
    await page.route('**/v1/auth/get-session', (route) =>
      route.fulfill({
        json: {
          user: { emailVerified: true },
          session: { id: 'monitoring-qa-fixture' },
        },
      }),
    );
    await page.route('**/v1/apps', (route) =>
      route.fulfill({
        headers: { 'x-app-health-workspace-role': 'owner' },
        json: {
          apps: report.projects.map((project) => ({
            app: { id: project.app_id, name: project.name, created_at: now },
            environments: [
              {
                id: project.environment_id,
                app_id: project.app_id,
                name: 'production',
                created_at: now,
              },
            ],
          })),
        },
      }),
    );
    await page.route('**/v1/analytics', (route) =>
      route.fulfill({
        json: {
          enabled: true,
          source: 'local',
          sampled: false,
          stream: false,
          projects: [],
          live,
        },
      }),
    );
    await page.routeWebSocket('**/v1/analytics/live', (socket) =>
      socket.send(JSON.stringify(live)),
    );
    await page.route('**/v1/workspace/health', (route) =>
      route.fulfill({
        json: {
          refreshed_at: now,
          window_end: now,
          window: '24h',
          environments: [],
        },
      }),
    );
    await page.route('**/v1/workspace/alerts', (route) =>
      route.fulfill({
        json: {
          generated_at: now,
          total_count: 1,
          entries: [
            {
              id: 'qa-failure',
              app_id: `qa-${policy.projects[0].catalog_id}`,
              catalog_id: policy.projects[0].catalog_id,
              project_name: policy.projects[0].name,
              event: 'journey.failed',
              level: 'error',
              source: 'server',
              timestamp: now - 120000,
              journey: 'home',
              location: 'cloudflare-hourly',
            },
          ],
          probes: [
            {
              location: 'cloudflare-hourly',
              last_seen_at: now - 120000,
              interval_seconds: 3600,
              state: 'fresh',
            },
          ],
        },
      }),
    );
    await page.route('**/v1/workspace/monitoring', (route) => route.fulfill({ json: report }));
    await page.route('**/v1/workspace/monitoring/policy', (route) =>
      route.fulfill({ json: { state: 'declared', project_count: 40 } }),
    );
    await page.goto('/app#overview');
    const monitoring = page.locator('[aria-labelledby="monitoring-title"]');
    await expect(page.getByLabel('Project monitoring coverage').locator(':scope > li')).toHaveCount(
      40,
    );
    await expect(page.getByText('missing checks', { exact: true })).toBeVisible();
    await expect(page.getByText('stale checks', { exact: true })).toBeVisible();
    const failing = page
      .getByLabel('Project monitoring coverage')
      .locator(':scope > li')
      .filter({ has: page.getByText(policy.projects[0].name, { exact: true }) });
    await failing.locator('summary').click();
    await expect(failing.getByText('timeout', { exact: false })).toBeVisible();
    mkdirSync(evidence, { recursive: true });
    await page.locator('#owner-alert-feed').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(evidence, `fixture-alerts-${width}.png`) });
    await monitoring.screenshot({ path: join(evidence, `fixture-coverage-${width}.png`) });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    await page.getByLabel('Monitoring roster file').setInputFiles({
      name: 'coverage.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(policy)),
    });
    await expect(page.getByText('Roster saved. Check results establish coverage.')).toBeVisible();
    await page.getByLabel('Monitoring roster file').setInputFiles({
      name: 'invalid.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{}'),
    });
    await expect(page.getByText('Choose a valid monitoring roster JSON file.')).toBeVisible();
    await page.getByRole('button', { name: 'Refresh monitoring' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(evidence, `fixture-import-error-${width}.png`) });
  });
}
