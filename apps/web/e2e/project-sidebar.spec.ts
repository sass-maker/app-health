import { expect, test, type Page } from '@playwright/test';

const projectCount = 55;
const createdAt = Date.UTC(2026, 9, 3);

/** Test-only GET /v1/apps fixture using the ListAppsResponseV1 contract shape. */
const qaInventory = {
  apps: Array.from({ length: projectCount }, (_, index) => {
    const number = String(index + 1).padStart(2, '0');
    const appId = `qa-only-sidebar-app-${number}`;
    return {
      app: {
        id: appId,
        name: `QA Sidebar Project ${number}`,
        created_at: createdAt + index,
      },
      environments: ['staging', 'production'].map((name, environmentIndex) => ({
        id: `${appId}-${name}`,
        app_id: appId,
        name,
        created_at: createdAt + index + environmentIndex,
      })),
    };
  }),
};

async function installNavigationFixture(page: Page): Promise<void> {
  await page.route('**/v1/auth/get-session', (route) =>
    route.fulfill({
      json: {
        user: { emailVerified: true },
        session: { id: 'qa-only-project-sidebar-session' },
      },
    }),
  );
  await page.route('**/v1/account/config', (route) => route.fulfill({ json: { google: true } }));
  await page.route('**/v1/apps', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: qaInventory }) : route.fallback(),
  );
}

test('searches the 55-project sidebar, selects production, and switches to Events locally', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await installNavigationFixture(page);
  await page.goto('/app#overview');

  await expect(page.getByRole('heading', { name: 'Daily briefing', exact: true })).toBeVisible();
  const projectButtons = page.getByRole('button', { name: /^QA Sidebar Project \d{2}$/ });
  await expect(projectButtons).toHaveCount(projectCount);

  await page.getByRole('textbox', { name: 'Search projects' }).fill('qa sidebar project 55');
  await expect(projectButtons).toHaveCount(1);
  await page.getByRole('button', { name: 'QA Sidebar Project 55', exact: true }).click();

  await expect(page).toHaveURL(
    /\/app\?project=qa-only-sidebar-app-55&environment=qa-only-sidebar-app-55-production#analytics$/,
  );
  await expect(page.getByRole('combobox', { name: 'Environment', exact: true })).toHaveText(
    'production',
  );
  await page.getByRole('tab', { name: 'Events', exact: true }).click();
  await expect(page).toHaveURL(/#events$/);
  await expect(page.getByRole('heading', { name: 'Events', exact: true })).toBeVisible();
});

test('mobile sidebar search closes after selection and restores focus to its toggle', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installNavigationFixture(page);
  await page.goto('/app#overview');

  const toggle = page.getByRole('button', { name: 'Toggle Sidebar', exact: true });
  await toggle.click();
  const sidebar = page.getByRole('dialog', { name: 'Sidebar', exact: true });
  await expect(sidebar).toBeVisible();
  await sidebar.getByRole('textbox', { name: 'Search projects' }).fill('QA Sidebar Project 54');
  await sidebar.getByRole('button', { name: 'QA Sidebar Project 54', exact: true }).click();

  await expect(sidebar).toBeHidden();
  await expect(toggle).toBeFocused();
  await expect(page.getByRole('combobox', { name: 'Environment', exact: true })).toHaveText(
    'production',
  );
});
