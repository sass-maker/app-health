import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

test('workspace settings preserve their layout and selection replaces the project and owner-only controls', async ({
  page,
  request,
}) => {
  const first = await (
    await request.post('/v1/apps', {
      data: { name: 'Personal research', environment: 'production' },
    })
  ).json();
  const second = await (
    await request.post('/v1/apps', { data: { name: 'Shared research', environment: 'production' } })
  ).json();
  await page.route('**/v1/apps', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const selected = route.request().headers()['x-app-health-workspace'] === 'ws-shared';
    const record = selected ? second : first;
    await route.fulfill({
      json: { apps: [{ app: record.app, environments: [record.environment] }] },
      headers: { 'x-app-health-workspace-role': selected ? 'viewer' : 'owner' },
    });
  });
  await page.route('**/v1/workspaces', (route) =>
    route.fulfill({
      json: {
        workspaces: [
          { id: 'ws-personal', name: 'Personal research', role: 'owner' },
          { id: 'ws-shared', name: 'Shared research', role: 'viewer' },
        ],
      },
    }),
  );
  await page.route('**/v1/workspace/members', (route) =>
    route.fulfill({
      json: {
        members: [
          { id: 'owner', name: 'Research owner', email: 'owner@example.test', role: 'owner' },
          { id: 'viewer', name: 'Reader', email: 'reader@example.test', role: 'viewer' },
        ],
      },
    }),
  );
  await page.route('**/v1/workspace/invites', (route) => route.fulfill({ json: { invites: [] } }));
  await page.route('**/v1/workspace/api-tokens', (route) =>
    route.fulfill({
      json: {
        tokens: [
          {
            id: 'token',
            name: 'Research assistant',
            permission: 'read',
            expires_at: Date.now() + 86400000,
            revoked_at: null,
          },
        ],
      },
    }),
  );
  await page.goto(`/app?project=${first.app.id}&environment=${first.environment.id}#settings`);
  await page.getByRole('button', { name: 'manage workspace access', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'team members', exact: true })).toBeVisible();
  const evidence = resolve(
    import.meta.dirname,
    '../../../.fleet-local/analytics-parity/workspace-access',
  );
  await mkdir(evidence, { recursive: true });
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: resolve(evidence, `settings-${width}.png`),
      fullPage: true,
      animations: 'disabled',
    });
  }
  await page.getByRole('combobox', { name: 'Selected workspace', exact: true }).click();
  await page.getByRole('option', { name: 'Shared research · viewer', exact: true }).click();
  await expect(page.getByText('return to personal workspace', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'manage workspace access', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'manage workspace access', exact: true }).click();
  await expect(
    page.getByText('Only workspace owners manage invitations, members and API tokens.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'team members', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'create API token', exact: true })).toHaveCount(0);
});
