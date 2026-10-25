import { useEffect, useState } from 'react';
import {
  PaymentImportJob,
  type PaymentConnection,
  type PaymentScopeV1,
} from '@app-health/contracts';
import { paymentProviderRequest, paymentScopeQuery } from './usePaymentConnections.js';
const inputTime = (value: number) => new Date(value).toISOString().slice(0, 19);

export function useConnectionActions(c: PaymentConnection, token: string, refresh: () => void) {
  const [open, setOpen] = useState(false),
    [replace, setReplace] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [from, setFrom] = useState(inputTime(Date.now() - 30 * 86400000)),
    [to, setTo] = useState(inputTime(Date.now()));
  const [job, setJob] = useState<PaymentImportJob | null>(null);
  const scope: PaymentScopeV1 = { app_id: c.app_id, environment_id: c.environment_id };
  const query = paymentScopeQuery(scope),
    base = `/v1/payment-connections/${c.id}`;
  async function action(path: string, method = 'POST', body?: unknown) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await paymentProviderRequest(`${path}?${query}`, token, method, body);
      const parsed = PaymentImportJob.safeParse(result);
      if (parsed.success) setJob(parsed.data);
      else setNotice('Payment connection updated.');
      refresh();
      return result;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Payment action unavailable.');
      return null;
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!job || !['queued', 'running'].includes(job.status)) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      void paymentProviderRequest(
        `/v1/payment-imports/${job.id}?${query}`,
        token,
        'GET',
        undefined,
        controller.signal,
      )
        .then((value) => {
          if (!controller.signal.aborted) setJob(PaymentImportJob.parse(value));
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setError('Import progress unavailable. Refresh the connection to retry.');
        });
    }, 2000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [job?.id, job?.status, query, token]);
  async function openDetails() {
    setOpen(!open);
    if (open) return;
    const result = await action(`${base}/jobs`, 'GET');
    const list = (result as { jobs?: unknown[] } | null)?.jobs;
    if (list?.length) setJob(PaymentImportJob.parse(list[0]));
  }
  const interval = { from: Date.parse(from + 'Z'), to: Date.parse(to + 'Z') };
  return {
    open,
    replace,
    setReplace,
    busy,
    error,
    notice,
    from,
    setFrom,
    to,
    setTo,
    job,
    base,
    action,
    openDetails,
    interval,
  };
}
