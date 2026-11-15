import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const now = Date.now();
const evidence =
  process.env.APP_HEALTH_EVIDENCE_DIRECTORY ??
  fileURLToPath(new URL('../../../.fleet/evidence/catalog-sync/', import.meta.url));
const canonical = process.env.APP_HEALTH_OWNER_CATALOG
  ? JSON.parse(readFileSync(process.env.APP_HEALTH_OWNER_CATALOG, 'utf8'))
  : {
      catalogSchemaVersion: 2,
      ownerNotes: 'PRIVATE_CANARY',
      projects: Array.from({ length: 40 }, (_, index) => ({
        id: `project-${index}`,
        name: `Canonical project ${index + 1}`,
        lifecycle: { status: 'retired', portfolioStatus: 'active' },
        classification: {
          kind: index < 30 ? 'product' : index < 33 ? 'platform' : 'experiment',
          futureForm:
            index < 11
              ? 'active-product'
              : index < 16
                ? 'support-tool'
                : index < 32
                  ? 'personal-tool'
                  : index < 37
                    ? 'finished-experiment'
                    : index === 37
                      ? 'paused-experiment'
                      : 'public-tool',
        },
        deployment: {
          authModel:
            index < 27
              ? 'public-persistent'
              : index < 34
                ? 'local-only'
                : index < 36
                  ? 'private-authenticated'
                  : index < 39
                    ? 'required-service'
                    : 'public-personalized',
        },
        ownerNotes: 'PRIVATE_CANARY',
        repositories: { localPath: '/private/canary' },
        systems: {
          appHealth: {
            browserVisitors: { applicability: 'not-applicable' },
            nativeSessions: 'unknown',
            serverRequests: 'applicable',
          },
          probe:
            index < 38
              ? { journeys: [{ journey: 'home', url: 'https://ignored.invalid/' }] }
              : { scope: index === 38 ? 'local' : 'private', absent: 'PRIVATE_CANARY' },
        },
      })),
    };
for (const width of [390, 768, 1440]) {
  test(`canonical portfolio import replaces57 with40 at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    let synchronized = false;
    let uploaded = '';
    const active = canonical.projects.filter(
      (row: { lifecycle: { portfolioStatus: string } }) =>
        row.lifecycle.portfolioStatus === 'active',
    );
    await page.route('**/v1/account/config', (route) => route.fulfill({ json: { google: true } }));
    await page.route('**/v1/auth/get-session', (route) =>
      route.fulfill({
        json: { user: { emailVerified: true }, session: { id: 'catalog-fixture' } },
      }),
    );
    await page.route('**/v1/apps', (route) =>
      route.fulfill({
        headers: { 'x-app-health-workspace-role': 'owner' },
        json: {
          apps: Array.from({ length: synchronized ? 40 : 57 }, (_, index) => ({
            app: {
              id: `app-${index}`,
              name: synchronized ? active[index].name : `Old project ${index + 1}`,
              created_at: now,
            },
            environments: [
              { id: `env-${index}`, app_id: `app-${index}`, name: 'production', created_at: now },
              ...(index === 0
                ? [{ id: 'env-stage', app_id: 'app-0', name: 'staging', created_at: now }]
                : []),
            ],
            ...(synchronized
              ? {
                  catalog: {
                    source: 'saas-maker',
                    catalog_id: active[index].id,
                    kind: active[index].classification.kind,
                    future_form: active[index].classification.futureForm,
                    auth_model: active[index].deployment.authModel,
                  },
                }
              : {}),
          })),
        },
      }),
    );
    await page.route('**/v1/catalog/sync', async (route) => {
      if (route.request().method() === 'POST') {
        uploaded = route.request().postData() ?? '';
        synchronized = true;
      }
      await route.fulfill({
        json: {
          source: synchronized ? 'saas-maker' : null,
          projection_hash: synchronized ? 'a'.repeat(64) : null,
          project_count: synchronized ? 40 : null,
          updated_at: synchronized ? now : null,
        },
      });
    });
    const live = { measured_at: now, ttl_ms: 45000, total: 0, projects: [] };
    await page.route('**/v1/analytics', (route) =>
      route.fulfill({
        json: { enabled: true, source: 'local', sampled: false, stream: false, projects: [], live },
      }),
    );
    await page.routeWebSocket('**/v1/analytics/live', (socket) =>
      socket.send(JSON.stringify(live)),
    );
    await page.route('**/v1/workspace/health', (route) =>
      route.fulfill({
        json: { refreshed_at: now, window_end: now, window: '24h', environments: [] },
      }),
    );
    await page.route('**/v1/workspace/alerts', (route) =>
      route.fulfill({ json: { generated_at: now, total_count: 0, entries: [], probes: [] } }),
    );
    await page.route('**/v1/workspace/monitoring', (route) =>
      route.fulfill({
        json: { schema_version: 1, generated_at: now, policy_updated_at: now, projects: [] },
      }),
    );
    await page.goto('/app#overview');
    const input = page.getByLabel('Canonical catalog JSON');
    await input.setInputFiles({
      name: 'invalid.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{'),
    });
    await expect(page.getByText('Choose a valid canonical catalog JSON file.')).toBeVisible();
    await input.setInputFiles({
      name: 'projects.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(canonical)),
    });
    await expect(page.getByText('40 active projects', { exact: true })).toBeVisible();
    await expect(page.getByText('5 support-tool', { exact: false })).toBeVisible();
    await expect(page.getByText('16 personal-tool', { exact: false })).toBeVisible();
    mkdirSync(evidence, { recursive: true });
    await page
      .getByLabel('Catalog preview')
      .screenshot({ path: join(evidence, `catalog-preview-${width}.png`) });
    await page.getByRole('button', { name: 'Synchronize active portfolio' }).click();
    await expect(page.getByText('SaaS Maker · 40 active projects')).toBeVisible();
    await expect(page.getByLabel('Monitoring roster file')).toHaveCount(0);
    expect(uploaded).not.toMatch(/PRIVATE_CANARY|localPath|ignored.invalid|ownerNotes/);
    expect(JSON.parse(uploaded).projects).toHaveLength(40);
    await page.getByText('request health and collection details', { exact: false }).click();
    await expect(
      page.getByLabel('Watchtower totals').getByText('40', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('41 environments in inventory')).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    await page.getByText('SaaS Maker · 40 active projects').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(evidence, `catalog-synchronized-${width}.png`) });
  });
}
