import type { PaymentConnection } from '@app-health/contracts';
import { Button } from '@saas-maker/ui/components/button';
import { Badge } from '@saas-maker/ui/components/badge';
import { useConnectionActions } from './useConnectionActions.js';
import { ConnectionDetails } from './PaymentConnectionDetails.js';
type Project = { appId: string; environmentId: string; name: string; environment: string };
type Props = {
  connection: PaymentConnection;
  projects: Project[];
  token: string;
  ingestOrigin: string;
  refresh: () => void;
};
export function PaymentConnectionCard(props: Props) {
  const { connection: c, projects, token, ingestOrigin, refresh } = props;
  const state = useConnectionActions(c, token, refresh);
  const { open, error, openDetails } = state;
  const delivery = c.webhook_at
    ? `${c.fixture ? 'fixture delivery' : 'verified webhook'} received ${new Date(c.webhook_at).toLocaleString()}`
    : 'no verified webhook received';
  return (
    <div className="min-w-0 space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">
            {c.provider} <Badge variant="secondary">{c.mode}</Badge>{' '}
            {c.fixture ? <Badge variant="outline">local fixture</Badge> : null}
          </h3>
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{c.account_id}</p>
          <p className="mt-2 text-xs">
            {c.status === 'active' ? 'credentials verified' : 'disconnected'} · {delivery}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void openDetails()} aria-expanded={open}>
          {open ? 'close connection' : `manage ${c.provider}`}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {open ? (
        <ConnectionDetails c={c} projects={projects} ingestOrigin={ingestOrigin} state={state} />
      ) : null}
    </div>
  );
}
