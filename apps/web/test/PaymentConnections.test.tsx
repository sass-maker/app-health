import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PaymentConnections } from '../src/PaymentConnections.js';
import { updateWorkspaceRole, workspaceScope } from '../src/lib/workspace-scope.js';
import type { PaymentConnection, PaymentImportJob } from '@app-health/contracts';

const project = { appId: 'app', environmentId: 'env', name: 'Product', environment: 'production' };
const connection: PaymentConnection = {
  id: '00000000-0000-4000-8000-000000000001',
  app_id: 'app',
  environment_id: 'env',
  provider: 'stripe',
  account_id: 'acct_test',
  mode: 'test',
  selector: null,
  generation: 1,
  status: 'active',
  routing: 'exclusive',
  rules: [],
  created_at: 1,
  verified_at: 1,
  webhook_at: null,
  webhook_path: '/v1/payment-webhooks/stripe/00000000-0000-4000-8000-000000000001',
  fixture: false,
};
const job: PaymentImportJob = {
  id: '00000000-0000-4000-8000-000000000002',
  connection_id: connection.id,
  kind: 'import',
  status: 'paused',
  phase: 'payments',
  from: 0,
  to: 10,
  processed: 2,
  recorded: 1,
  unresolved: 1,
  filtered: 0,
  reason: 'provider_rate_limited',
  retry_at: 0,
  created_at: 1,
  updated_at: 1,
  coverage_note: 'Observed pages only; multicapture timing unsupported.',
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function renderPanel() {
  updateWorkspaceRole('owner', workspaceScope().epoch);
  return render(
    <PaymentConnections
      project={project}
      projects={[project]}
      ownerToken="owner"
      ingestOrigin="https://ingest.test"
    />,
  );
}
it('clears credential inputs before network completion and does not repopulate them after rejection', async () => {
  let reject!: (reason: Error) => void;
  const mock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
    init?.method === 'POST'
      ? new Promise<Response>((_resolve, fail) => {
          reject = fail;
        })
      : Response.json({ connections: [], fixture_mode: false }),
  );
  vi.stubGlobal('fetch', mock);
  renderPanel();
  await screen.findByText('No payment provider connected to this environment.');
  fireEvent.click(screen.getByRole('button', { name: 'connect payment provider' }));
  fireEvent.change(screen.getByLabelText('Provider API key'), {
    target: { value: 'sk_test_synthetic' },
  });
  fireEvent.change(screen.getByLabelText('Webhook signing secret'), {
    target: { value: 'whsec_synthetic' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'connect provider' }));
  expect(screen.getByLabelText('Provider API key')).toHaveValue('');
  expect(screen.getByLabelText('Webhook signing secret')).toHaveValue('');
  await act(async () => reject(new Error('provider denied')));
  expect(await screen.findByRole('alert')).toHaveTextContent('provider denied');
  expect(screen.getByLabelText('Provider API key')).toHaveValue('');
  expect(screen.getByLabelText('Webhook signing secret')).toHaveValue('');
});
it('configures product routing, exposes honest webhook state, resumes and cancels jobs, replaces and disconnects', async () => {
  let current = { ...connection };
  const bodies: { path: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), location.origin),
        method = init?.method ?? 'GET',
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      bodies.push({ path: url.pathname, method, body });
      if (url.pathname === '/v1/payment-connections')
        return Response.json({ connections: [current], fixture_mode: false });
      if (url.pathname.endsWith('/jobs')) return Response.json({ jobs: [] });
      if (url.pathname.endsWith('/routing')) {
        current = { ...current, ...body };
        return Response.json(current);
      }
      if (url.pathname.endsWith('/imports')) return Response.json(job);
      if (url.pathname.endsWith('/resume'))
        return Response.json({ ...job, status: 'finished', phase: 'done' });
      if (url.pathname.endsWith('/reconcile'))
        return Response.json({ ...job, status: 'paused', kind: 'reconcile' });
      if (url.pathname.endsWith('/cancel')) return Response.json({ ...job, status: 'cancelled' });
      if (method === 'DELETE') {
        current = { ...current, status: 'disconnected' };
        return Response.json({ disconnected: true });
      }
      return Response.json({ verified: true });
    }),
  );
  renderPanel();
  fireEvent.click(await screen.findByRole('button', { name: 'manage stripe' }));
  expect(await screen.findByLabelText('stripe webhook endpoint')).toHaveValue(
    'https://ingest.test' + connection.webhook_path,
  );
  expect(screen.getByText('credentials verified · no verified webhook received')).toBeVisible();
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Payment routing' }), {
    key: 'ArrowDown',
  });
  fireEvent.click(
    await screen.findByRole('option', { name: 'product allowlists · whole transaction' }),
  );
  fireEvent.change(screen.getByLabelText('Provider product ID'), { target: { value: 'prod_123' } });
  fireEvent.click(screen.getByRole('button', { name: 'add product rule' }));
  fireEvent.click(screen.getByRole('button', { name: 'save routing' }));
  await waitFor(() =>
    expect(bodies).toContainEqual({
      path: `/v1/payment-connections/${connection.id}/routing`,
      method: 'PUT',
      body: {
        routing: 'products',
        rules: [{ product_id: 'prod_123', app_id: 'app', environment_id: 'env' }],
      },
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'import history' }));
  fireEvent.click(await screen.findByRole('button', { name: 'resume import' }));
  expect(await screen.findByText('import · finished · done')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'reconcile period' }));
  fireEvent.click(await screen.findByRole('button', { name: 'cancel import' }));
  expect(await screen.findByText('import · cancelled · payments')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'verify credentials' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'disconnect' })).not.toBeDisabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'replace credentials' }));
  fireEvent.change(screen.getByLabelText('Provider API key'), { target: { value: 'sk_test_new' } });
  fireEvent.change(screen.getByLabelText('Webhook signing secret'), {
    target: { value: 'whsec_new' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'replace saved credentials' }));
  await waitFor(() => expect(screen.queryByLabelText('Provider API key')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'disconnect' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'disconnect' })).toBeDisabled());
});
it('never renders a late connection list from another project', async () => {
  let old!: (response: Response) => void;
  const mock = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          old = resolve;
        }),
    )
    .mockResolvedValue(Response.json({ connections: [], fixture_mode: true }));
  vi.stubGlobal('fetch', mock);
  const view = renderPanel();
  view.rerender(
    <PaymentConnections
      project={{ ...project, appId: 'other' }}
      projects={[project]}
      ownerToken="owner"
      ingestOrigin="https://ingest.test"
    />,
  );
  await screen.findByText('No payment provider connected to this environment.');
  await act(async () => old(Response.json({ connections: [connection], fixture_mode: false })));
  expect(screen.queryByText('acct_test')).toBeNull();
});
