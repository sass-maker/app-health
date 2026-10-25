import { Button } from '@saas-maker/ui/components/button';
import { Input } from '@saas-maker/ui/components/input';
import type { PaymentImportJob } from '@app-health/contracts';
import { PaymentRoutingEditor } from './PaymentRoutingEditor.js';
import { ConnectionControls, ImportControls } from './PaymentConnectionControls.js';
import type { PaymentConnection } from '@app-health/contracts';
import type { useConnectionActions } from './useConnectionActions.js';
type ConnectionState = ReturnType<typeof useConnectionActions>;
type Project = { appId: string; environmentId: string; name: string; environment: string };
type JobProgressProps = {
  job: PaymentImportJob;
  resume: () => void;
  cancel: () => void;
  busy: boolean;
};
function JobProgress({ job, resume, cancel, busy }: JobProgressProps) {
  return (
    <div role="status" className="space-y-1 rounded-md bg-muted p-3 text-xs leading-5">
      <p className="font-medium">
        {job.kind} · {job.status} · {job.phase}
      </p>
      <p>
        {job.processed} resources checked · {job.recorded} resources newly recorded ·{' '}
        {job.unresolved} unresolved · {job.filtered} outside connection/period
      </p>
      {job.reason ? <p>{job.reason.replaceAll('_', ' ')}</p> : null}
      {job.retry_at > Date.now() ? (
        <p>Next attempt after {new Date(job.retry_at).toLocaleTimeString()}.</p>
      ) : null}
      <p className="text-muted-foreground">{job.coverage_note}</p>
      {['queued', 'running', 'paused'].includes(job.status) ? (
        <Button size="sm" variant="ghost" disabled={busy} onClick={cancel}>
          cancel import
        </Button>
      ) : null}
      {job.status === 'paused' ? (
        <Button size="sm" variant="outline" disabled={busy} onClick={resume}>
          resume import
        </Button>
      ) : null}
    </div>
  );
}

export function ConnectionDetails({
  c,
  projects,
  ingestOrigin,
  state,
}: {
  c: PaymentConnection;
  projects: Project[];
  ingestOrigin: string;
  state: ConnectionState;
}) {
  const { busy, notice, job, base, action } = state;
  return (
    <div className="space-y-4 border-t pt-4">
      <label className="grid gap-1.5 text-xs">
        Webhook endpoint
        <Input
          aria-label={`${c.provider} webhook endpoint`}
          readOnly
          value={ingestOrigin + c.webhook_path}
          onFocus={(event) => event.currentTarget.select()}
        />
      </label>
      <p className="text-xs leading-5 text-muted-foreground">
        Configure this URL in your provider account with the matching signing secret.{' '}
        {c.provider === 'stripe'
          ? 'Subscribe to charge.succeeded, charge.updated, charge.captured, refund.created and refund.updated.'
          : c.provider === 'polar'
            ? 'Use raw webhooks, API version 2026-10; subscribe to order.paid, order.updated, refund.created and refund.updated.'
            : 'Subscribe to payment.succeeded and refund.succeeded.'}{' '}
        A successful credential check does not verify webhook delivery.
      </p>
      <ConnectionControls c={c} state={state} />
      {notice ? (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      ) : null}
      <PaymentRoutingEditor
        connection={c}
        projects={projects}
        busy={busy}
        save={(routing) => void action(`${base}/routing`, 'PUT', routing)}
      />
      <ImportControls c={c} state={state} />
      {job ? (
        <JobProgress
          job={job}
          busy={busy}
          resume={() => void action(`/v1/payment-imports/${job.id}/resume`, 'POST', {})}
          cancel={() => void action(`/v1/payment-imports/${job.id}/cancel`, 'POST', {})}
        />
      ) : null}
    </div>
  );
}
