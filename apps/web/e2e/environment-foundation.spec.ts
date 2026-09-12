import { expect, test } from '@playwright/test';
import { checkReadability } from './readability';

for (const theme of ['dark', 'light']) {
  test(`independent capability receipt and environment isolation ${theme}`, async ({ page }) => {
    test.setTimeout(45000);
    await page.setViewportSize({ width: theme === 'dark' ? 390 : 1440, height: 1000 });
    const createdResponse = await page.request.post('/v1/apps', {
      data: {
        name: `Foundation ${theme} ${Date.now()}`,
        environment: 'production',
        key_scope: 'environment',
      },
    });
    expect(createdResponse.status()).toBe(201);
    const created = await createdResponse.json();
    await page.addInitScript(
      ({ project, mode }) => {
        localStorage.setItem('app-health-theme', mode);
        localStorage.setItem('app-health-v0-project', JSON.stringify(project));
      },
      {
        project: {
          appId: created.app.id,
          environmentId: created.environment.id,
          name: created.app.name,
          environment: created.environment.name,
        },
        mode: theme,
      },
    );
    const scope = `app_id=${created.app.id}&environment_id=${created.environment.id}`;
    expect(
      (
        await page.request.put(`/v1/capabilities?${scope}`, {
          data: { enabled: ['analytics', 'endpoints', 'logs'] },
        })
      ).ok(),
    ).toBe(true);
    await page.goto('/app#logs');
    await expect(page.getByText('Waiting for the first valid logs event')).toBeVisible();
    await checkReadability(page);
    const log = {
      log_id: crypto.randomUUID(),
      timestamp: Date.now(),
      event: 'foundation.completed',
      level: 'info',
      props: { check: 'environment' },
    };
    const result = await page.request.post('/v1/logs', {
      headers: { authorization: `Bearer ${created.key.key}` },
      data: { schema_version: 'v1', logs: [log] },
    });
    expect(result.status()).toBe(202);
    await expect(page.getByText('foundation.completed', { exact: true })).toBeVisible({
      timeout: 12000,
    });
    await expect(page.getByText('Waiting for the first valid logs event')).toHaveCount(0);
    await checkReadability(page);
    await page.goto('/app#analytics');
    await expect(page.getByText('Install web analytics', { exact: true })).toBeVisible();
    await page.goto('/app#endpoints');
    await expect(page.getByText('Waiting for the first valid endpoint health event')).toBeVisible();
    const endpoint = {
      schema_version: 'v1',
      batch_id: crypto.randomUUID(),
      runtime: 'worker',
      environment: 'production',
      events: [
        {
          event_id: crypto.randomUUID(),
          timestamp: Date.now(),
          method: 'GET',
          route: '/foundation',
          status_code: 200,
          duration_ms: 4,
        },
      ],
    };
    expect(
      (
        await page.request.post('/v1/ingest', {
          headers: { authorization: `Bearer ${created.key.key}` },
          data: endpoint,
        })
      ).status(),
    ).toBe(202);
    await expect(
      page.getByText('/foundation', { exact: true }).filter({ visible: true }),
    ).toBeVisible({ timeout: 12000 });
    await page.goto('/app#settings');
    await expect(
      page.getByRole('heading', { name: 'Project settings', exact: true }),
    ).toBeVisible();
    await checkReadability(page);
    await page.getByLabel('New environment name').fill('staging');
    const added = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/v1/apps/${created.app.id}/environments`) &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Add environment', exact: true }).click();
    const staging = await (await added).json();
    expect(staging.environment.name).toBe('staging');
    expect(staging.key.environment_id).toBe(staging.environment.id);
    await expect(page.getByText('Save the private key for staging')).toBeVisible();
    await checkReadability(page);
    const state = await (
      await page.request.get(
        `/v1/capabilities?app_id=${created.app.id}&environment_id=${staging.environment.id}`,
      )
    ).json();
    expect(
      state.capabilities.every(
        (c: { first_received_at: number | null }) => c.first_received_at === null,
      ),
    ).toBe(true);
    expect(
      (
        await page.request.post('/v1/ingest', {
          headers: { authorization: `Bearer ${staging.key.key}` },
          data: endpoint,
        })
      ).status(),
    ).toBe(400);
    await page.getByRole('combobox', { name: 'Environment', exact: true }).click();
    await page.getByRole('option', { name: 'staging', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Environment', exact: true })).toHaveText(
      'staging',
    );
    await expect(page.getByText(`Workspace / ${created.app.name} / staging`)).toBeVisible();
    await checkReadability(page);
    await expect(page.locator('footer')).toHaveCount(0);
  });
}
