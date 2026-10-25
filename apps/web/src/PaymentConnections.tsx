import { useState } from 'react';
import {
  PaymentConnection,
  type PaymentCredentials,
  type PaymentProvider,
} from '@app-health/contracts';
import { Button } from '@saas-maker/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@saas-maker/ui/components/card';
import { Input } from '@saas-maker/ui/components/input';
import { LabeledSelect } from './LabeledSelect.js';
import { PaymentCredentialsForm } from './PaymentCredentialsForm.js';
import { PaymentConnectionCard } from './PaymentConnectionCard.js';
import {
  usePaymentConnections,
  paymentProviderRequest,
  paymentScopeQuery,
} from './usePaymentConnections.js';

type Project = { appId: string; environmentId: string; name: string; environment: string };
export function PaymentConnections({
  project,
  projects,
  ownerToken,
  ingestOrigin,
}: {
  project: Project;
  projects: Project[];
  ownerToken: string;
  ingestOrigin: string;
}) {
  const state = useConnectionsController(project, ownerToken);
  const { add, setAdd, busy, error, connect } = state;
  return (
    <Card className="shadow-none">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="text-sm">payment connections</CardTitle>
            <CardDescription className="mt-1">
              Stripe, Polar and Dodo · verified account, mode and destination.
            </CardDescription>
          </div>
          <Button variant="outline" disabled={state.loading} onClick={() => setAdd(!add)}>
            {add ? 'cancel connection' : 'connect payment provider'}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs leading-5 text-muted-foreground">
          Provider reports use resource creation dates and gross paid order/payment values including
          tax. Stripe individual multicapture history is unsupported. Custom server cashflows remain
          separate.
        </p>
        {state.loading ? (
          <p role="status" className="text-xs text-muted-foreground">
            reading payment connections…
          </p>
        ) : null}
        {state.error || error ? (
          <div role="alert" className="text-xs text-destructive">
            {state.error || error}
            <Button variant="ghost" size="sm" onClick={state.refresh}>
              refresh connections
            </Button>
          </div>
        ) : null}
        {add ? <ConnectionForm state={state} busy={busy} connect={connect} /> : null}
        {!state.loading && !state.connections.length ? (
          <p className="text-xs text-muted-foreground">
            No payment provider connected to this environment.
          </p>
        ) : null}
        {state.connections.map((connection) => (
          <PaymentConnectionCard
            key={connection.id}
            connection={connection}
            projects={projects}
            token={ownerToken}
            ingestOrigin={ingestOrigin}
            refresh={state.refresh}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function useConnectionsController(project: Project, ownerToken: string) {
  const scope = { app_id: project.appId, environment_id: project.environmentId };
  const state = usePaymentConnections(scope, ownerToken);
  const [provider, setProvider] = useState<PaymentProvider>('stripe'),
    [mode, setMode] = useState<'live' | 'test'>('test'),
    [selector, setSelector] = useState('');
  const [add, setAdd] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function connect(credentials: PaymentCredentials | undefined) {
    setBusy(true);
    setError('');
    try {
      PaymentConnection.parse(
        await paymentProviderRequest(
          `/v1/payment-connections?${paymentScopeQuery(scope)}`,
          ownerToken,
          'POST',
          {
            ...scope,
            provider,
            mode: state.fixture ? 'test' : mode,
            ...(selector ? { selector } : {}),
            credentials,
            fixture: state.fixture,
          },
        ),
      );
      setAdd(false);
      setSelector('');
      state.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Provider connection unavailable.');
    } finally {
      setBusy(false);
    }
  }
  return {
    ...state,
    provider,
    setProvider,
    mode,
    setMode,
    selector,
    setSelector,
    add,
    setAdd,
    busy,
    error,
    connect,
  };
}

function ConnectionForm({
  state,
  busy,
  connect,
}: {
  state: ReturnType<typeof useConnectionsController>;
  busy: boolean;
  connect: (credentials: PaymentCredentials | undefined) => Promise<void>;
}) {
  const { provider, setProvider, mode, setMode, selector, setSelector } = state;
  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <LabeledSelect
          label="Payment provider"
          value={provider}
          onValueChange={(value) => {
            setProvider(value as PaymentProvider);
            setSelector('');
          }}
          options={['stripe', 'polar', 'dodo'].map((value) => ({ value, label: value }))}
        />
        <LabeledSelect
          label="Provider mode"
          value={state.fixture ? 'test' : mode}
          onValueChange={(value) => setMode(value as typeof mode)}
          options={
            state.fixture
              ? [{ value: 'test', label: 'test fixture' }]
              : [
                  { value: 'test', label: 'test / sandbox' },
                  { value: 'live', label: 'live' },
                ]
          }
        />
      </div>
      {provider !== 'stripe' && !state.fixture ? (
        <label className="grid gap-1.5 text-xs">
          {provider === 'polar' ? 'Organization ID' : 'Brand ID'}
          <Input
            aria-label={provider === 'polar' ? 'Organization ID' : 'Brand ID'}
            value={selector}
            onChange={(event) => setSelector(event.target.value)}
            required
          />
        </label>
      ) : null}
      <PaymentCredentialsForm
        key={provider}
        provider={provider}
        fixture={state.fixture}
        busy={busy}
        onSubmit={(credentials) => void connect(credentials)}
      />
    </div>
  );
}
