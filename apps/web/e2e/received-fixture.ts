import type { Page } from '@playwright/test';

/** These report-state fixtures represent an already-connected environment, even when its window is empty. */
export async function receivedFixture(page: Page, id: 'analytics' | 'endpoints' | 'logs') {
  await page.route('**/v1/capabilities?**', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.capabilities = body.capabilities.map((state: { id: string }) =>
      state.id === id
        ? {
            ...state,
            enabled: true,
            first_received_at: Date.now() - 86_400_000,
            last_received_at: Date.now() - 3_600_000,
          }
        : state,
    );
    await route.fulfill({ response, json: body });
  });
}
