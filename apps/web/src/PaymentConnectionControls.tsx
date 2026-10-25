import { Button } from '@saas-maker/ui/components/button';
import { Input } from '@saas-maker/ui/components/input';
import { PaymentCredentialsForm } from './PaymentCredentialsForm.js';
import type { PaymentConnection } from '@app-health/contracts';
import type { useConnectionActions } from './useConnectionActions.js';
type ConnectionState = ReturnType<typeof useConnectionActions>;

export function ConnectionControls({ c, state }: { c: PaymentConnection; state: ConnectionState }) {
  const { busy, base, replace, setReplace, action } = state;
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || c.status !== 'active'}
          onClick={() => void action(`${base}/verify`)}
        >
          verify credentials
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setReplace(!replace)}>
          replace credentials
        </Button>
        {c.fixture ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || c.status !== 'active'}
            onClick={() => void action(`${base}/fixture-webhook`, 'POST', {})}
          >
            simulate fixture webhook
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="destructive"
          disabled={busy || c.status !== 'active'}
          onClick={() => void action(base, 'DELETE')}
        >
          disconnect
        </Button>
      </div>
      {replace ? (
        <PaymentCredentialsForm
          provider={c.provider}
          fixture={c.fixture}
          busy={busy}
          label="replace saved credentials"
          onSubmit={(credentials) => {
            setReplace(false);
            void action(`${base}/credentials`, 'POST', credentials ?? { fixture: true });
          }}
        />
      ) : null}
    </>
  );
}

export function ImportControls({ c, state }: { c: PaymentConnection; state: ConnectionState }) {
  const { busy, base, from, setFrom, to, setTo, interval, action } = state;
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <h4 className="text-xs font-medium">History import & reconciliation</h4>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-xs">
          From · UTC
          <Input
            aria-label="Import from UTC"
            type="datetime-local"
            step="1"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-xs">
          To · UTC
          <Input
            aria-label="Import to UTC"
            type="datetime-local"
            step="1"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={busy || c.status !== 'active'}
          onClick={() => void action(`${base}/imports`, 'POST', interval)}
        >
          import history
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || c.status !== 'active'}
          onClick={() => void action(`${base}/reconcile`, 'POST', interval)}
        >
          reconcile period
        </Button>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        Imports resume from durable cursors. Reconciliation revisits the selected creation-date
        interval, including previously unresolved resources. Disconnect stops future writes and
        retains financial facts and original routing.
      </p>
    </div>
  );
}
