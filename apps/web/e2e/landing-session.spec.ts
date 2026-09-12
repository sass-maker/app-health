import { expect, test } from '@playwright/test';

test('a returning session survives refresh and does not trap Back on the landing page', async ({
  page,
}) => {
  let signedIn = false;
  await page.route('**/v1/auth/get-session', (route) =>
    route.fulfill({
      json: signedIn
        ? { user: { emailVerified: true }, session: { id: 'returning-session' } }
        : null,
    }),
  );
  await page.route('**/v1/account/config', (route) => route.fulfill({ json: { google: true } }));
  await page.route('**/v1/apps', (route) => route.fulfill({ json: { apps: [] } }));
  await page.goto('/privacy');
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /See what people do/ })).toBeVisible();

  signedIn = true;
  await page.reload();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole('button', { name: 'Create project', exact: true })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole('button', { name: 'Create project', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/privacy$/);
});

test('a failed session check leaves the landing page usable', async ({ page }) => {
  await page.route('**/v1/auth/get-session', (route) => route.fulfill({ status: 503 }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /See what people do/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: /See what people do/ })).toBeVisible();
  await page.getByRole('link', { name: 'Open App Health', exact: true }).first().click();
  await expect(page).toHaveURL(/\/app$/);
});

test('restoring an existing project preserves the selection without adding refresh history', async ({
  page,
}) => {
  const response = await page.request.post('/v1/apps', {
    data: {
      name: `Returning project ${Date.now()}`,
      environment: 'staging',
      key_scope: 'environment',
    },
  });
  expect(response.status()).toBe(201);
  const created = await response.json();
  await page.route('**/v1/auth/get-session', (route) =>
    route.fulfill({ json: { user: { emailVerified: true }, session: { id: 'existing-session' } } }),
  );
  await page.route('**/v1/account/config', (route) => route.fulfill({ json: { google: true } }));
  await page.route('**/v1/apps', (route) =>
    route.fulfill({ json: { apps: [{ app: created.app, environments: [created.environment] }] } }),
  );
  await page.goto('/privacy');
  await page.goto('/');
  await expect(page).toHaveURL(new RegExp(`project=${created.app.id}`));
  await expect(page.getByRole('combobox', { name: 'Environment', exact: true })).toHaveText(
    'staging',
  );
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Environment', exact: true })).toHaveText(
    'staging',
  );
  await page.goBack();
  await expect(page).toHaveURL(/\/privacy$/);
});
