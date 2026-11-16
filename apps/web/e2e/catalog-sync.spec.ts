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
              ? {
                  journeys: [{ journey: 'home', url: 'https://ignored.invalid/', budget_ms: 2000 }],
                }
              : { scope: index === 38 ? 'local' : 'private', absent: 'PRIVATE_CANARY' },
        },
      })),
    };
for (const { width, failReadback } of [
  { width: 390, failReadback: false },
  { width: 768, failReadback: false },
  { width: 1440, failReadback: false },
  { width: 390, failReadback: true },
  { width: 1440, failReadback: true },
]) {
  test(`canonical portfolio import replaces57 with40 at ${width}px, readback failure=${failReadback}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    let synchronized = false;
    let automaticRemoval = false;
    let connected = false;
    let needsReview = true;
    let inventoryUnavailable = failReadback;
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
      synchronized && inventoryUnavailable
        ? route.fulfill({ status: 503, body: 'temporarily unavailable' })
        : route.fulfill({
            headers: { 'x-app-health-workspace-role': 'owner' },
            json: {
              apps: Array.from(
                { length: synchronized ? (automaticRemoval ? 39 : 40) : 57 },
                (_, index) => ({
                  app: {
                    id: `app-${index}`,
                    name: synchronized ? active[index].name : `Old project ${index + 1}`,
                    created_at: now,
                  },
                  environments: [
                    {
                      id: `env-${index}`,
                      app_id: `app-${index}`,
                      name: 'production',
                      created_at: now,
                    },
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
                }),
              ),
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
          projection_hash: synchronized ? (automaticRemoval ? 'b' : 'a').repeat(64) : null,
          project_count: synchronized ? (automaticRemoval ? 39 : 40) : null,
          updated_at: synchronized ? now : null,
          mapped_catalog_ids: synchronized
            ? active.map((row: { id: string }) => row.id)
            : [
                ...active.slice(0, 36).map((row: { id: string }) => row.id),
                ...Array.from({ length: 20 }, (_, index) => `legacy-${index}`),
              ],
          unlinked_apps: [{ app_id: 'app-56', name: 'External project' }],
        },
      });
    });
    await page.route('**/v1/catalog/publishers', (route) =>
      route.fulfill({
        json: {
          publishers: connected
            ? [
                {
                  id: '11111111-1111-4111-8111-111111111111',
                  label: 'Fleet Mac',
                  approved_at: now,
                  revoked_at: null,
                  last_attempt_at: null,
                  last_success_at: null,
                  last_error: needsReview ? 'review_required' : null,
                },
              ]
            : [],
        },
      }),
    );
    await page.route('**/v1/catalog/publishers/pairing?*', (route) =>
      route.fulfill({ json: { label: 'Fleet Mac' } }),
    );
    await page.route('**/v1/catalog/publishers/approve', async (route) => {
      expect(route.request().postDataJSON()).toEqual({
        code: 'ABCDEF123456',
        allow_automatic_updates: true,
        preserve_outside_catalog_app_ids: ['app-56'],
      });
      connected = true;
      await route.fulfill({ json: { publisher_id: '11111111-1111-4111-8111-111111111111' } });
    });
    await page.route('**/v1/catalog/publishers/review', async (route) => {
      expect(route.request().postDataJSON()).toEqual({
        publisher_id: '11111111-1111-4111-8111-111111111111',
        allow_automatic_updates: true,
        preserve_outside_catalog_app_ids: ['app-56'],
      });
      needsReview = false;
      await route.fulfill({ json: { publisher_id: '11111111-1111-4111-8111-111111111111' } });
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
    await page.goto('/app?project=app-56&environment=env-56#overview');
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
    await expect(
      page.getByText('36 selected projects already mapped · 4 new metadata projects'),
    ).toBeVisible();
    mkdirSync(evidence, { recursive: true });
    await page
      .getByLabel('Catalog preview')
      .screenshot({ path: join(evidence, `catalog-preview-${width}.png`) });
    await expect(page.getByRole('button', { name: 'Synchronize active portfolio' })).toBeDisabled();
    await page
      .getByRole('checkbox', { name: /Keep External project outside this catalog/ })
      .check();
    await page
      .getByLabel('Catalog preview')
      .screenshot({ path: join(evidence, `catalog-outside-${width}.png`) });
    await page.getByRole('button', { name: 'Synchronize active portfolio' }).click();
    await expect(
      page.getByText(
        'Catalog synchronized. 40 active projects and their monitoring policy are committed.',
      ),
    ).toBeVisible();
    if (failReadback) {
      await expect(
        page.getByText(
          'The catalog is committed. Inventory refresh is unavailable; retry its refresh.',
        ),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Old project 57', exact: true })).toHaveCount(
        0,
      );
      await page.screenshot({
        path: join(evidence, `catalog-committed-unavailable-${width}.png`),
        fullPage: true,
      });
      inventoryUnavailable = false;
      await page.getByRole('button', { name: 'try again', exact: true }).click();
    }

    await expect(page.getByText('SaaS Maker · 40 active projects')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Dismiss catalog confirmation' })).toBeVisible();
    await page.screenshot({
      path: join(evidence, `catalog-confirmed-${width}-${failReadback}.png`),
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Dismiss catalog confirmation' }).click();
    await expect(
      page.getByText(
        'Catalog synchronized. 40 active projects and their monitoring policy are committed.',
      ),
    ).toHaveCount(0);
    expect(new URL(page.url()).search).toBe('');
    await page.reload();
    await expect(page.getByText('SaaS Maker · 40 active projects')).toBeVisible();
    await expect(page.getByText('project unavailable', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Monitoring roster file')).toHaveCount(0);
    expect(uploaded).not.toMatch(/PRIVATE_CANARY|localPath|ignored.invalid|ownerNotes/);
    expect(JSON.parse(uploaded).projects).toHaveLength(40);
    expect(JSON.parse(uploaded).preserve_outside_catalog_app_ids).toEqual(['app-56']);
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
    if (!failReadback) {
      await page.getByText('Automatic catalog updates', { exact: true }).click();
      await page.getByLabel('Connection code from your Mac').fill('ABCDEF123456');
      await page.getByRole('button', { name: 'Review connection', exact: true }).click();
      await expect(page.getByText('Connect Fleet Mac', { exact: true })).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Connect automatic updates', exact: true }),
      ).toBeDisabled();
      await page
        .getByRole('checkbox', { name: /Keep External project outside this catalog/ })
        .check();
      await page
        .getByRole('checkbox', {
          name: 'Allow automatic updates to this workspace from this connection.',
        })
        .check();
      await page
        .getByLabel('Confirm automatic catalog connection')
        .screenshot({ path: join(evidence, `catalog-publisher-review-${width}.png`) });
      await page.getByRole('button', { name: 'Connect automatic updates', exact: true }).click();
      await expect(page.getByText('Fleet Mac · connected', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Review outside projects', exact: true }).click();
      await expect(page.getByText('Review Fleet Mac', { exact: true })).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Resume automatic updates', exact: true }),
      ).toBeDisabled();
      await page
        .getByRole('checkbox', { name: /Keep External project outside this catalog/ })
        .check();
      await page
        .getByRole('checkbox', {
          name: 'Allow automatic updates to this workspace from this connection.',
        })
        .check();
      await page
        .getByLabel('Confirm automatic catalog connection')
        .screenshot({ path: join(evidence, `catalog-publisher-outside-review-${width}.png`) });
      await page.getByRole('button', { name: 'Resume automatic updates', exact: true }).click();
      await expect(
        page.getByText(
          'Outside-project decisions updated. The publisher will retry automatically.',
        ),
      ).toBeVisible();
      automaticRemoval = true;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(
        page.getByText('SaaS Maker · 39 active projects', { exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: active[39].name, exact: true })).toHaveCount(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
      ).toBeLessThanOrEqual(1);
      await page
        .getByText('SaaS Maker · 39 active projects', { exact: true })
        .scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(evidence, `catalog-publisher-live39-${width}.png`) });
    }
  });
}
