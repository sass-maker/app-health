import { useState } from 'react';
import type {
  RevenueReportV1,
  RevenueTotalV1,
  ProviderRevenueReportV1,
} from '@app-health/contracts';
import { Button } from '@saas-maker/ui/components/button';
import { Card, CardContent, CardHeader } from '@saas-maker/ui/components/card';
import { LabeledSelect } from './LabeledSelect.js';
import { useRevenue, type RevenueScope } from './useRevenue.js';
import { averagePayment, formatPaymentMinor } from './lib/payment-format.js';

const namespace = (row: RevenueTotalV1) =>
  `${row.provider} · ${row.account_id} · ${row.mode} · ${row.currency}`;
const rowKey = (row: RevenueTotalV1) =>
  JSON.stringify([row.provider, row.account_id, row.mode, row.currency]);

function RevenueTotals({ rows, provider }: { rows: RevenueTotalV1[]; provider: boolean }) {
  return (
    <div className="grid gap-3 xl:grid-cols-2">
      {rows.map((row) => (
        <div key={rowKey(row)} className="min-w-0 rounded-lg border p-4">
          <h3 className="break-all text-xs font-medium">{namespace(row)}</h3>
          <p className="mt-2 break-words text-2xl font-semibold tabular-nums">
            {formatPaymentMinor(row.net_minor, row.currency)}
          </p>
          <p className="text-xs text-muted-foreground">
            {provider ? 'net paid order/payment value' : 'net recorded cashflow'}
          </p>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
            <div>
              <dt className="text-muted-foreground">
                {provider ? 'gross paid order/payment values' : 'gross payments'}
              </dt>
              <dd className="mt-1 tabular-nums">
                {formatPaymentMinor(row.gross_minor, row.currency)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">refunds</dt>
              <dd className="mt-1 tabular-nums">
                {formatPaymentMinor(row.refunds_minor, row.currency)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">payments</dt>
              <dd className="mt-1 tabular-nums">{row.payments.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">average payment</dt>
              <dd className="mt-1 tabular-nums">
                {averagePayment(row.gross_minor, row.payments, row.currency)}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            {row.attributed_payments.toLocaleString()} of {row.payments.toLocaleString()} payments
            carry an explicit source, page, country or campaign.
          </p>
          {row.pending_refunds ? (
            <p className="mt-2 text-xs leading-5">
              {row.pending_refunds.toLocaleString()} refunds await their original payment:{' '}
              {formatPaymentMinor(row.pending_refunds_minor, row.currency)} excluded from net.
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function RevenueDimensions({
  report,
}: {
  report: Pick<RevenueReportV1, 'breakdown' | 'dimensions'>;
}) {
  if (!report.dimensions.length) return null;
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-left text-xs" aria-label={`Revenue by ${report.breakdown}`}>
        <thead className="border-b text-muted-foreground">
          <tr>
            <th className="p-3">{report.breakdown}</th>
            <th className="p-3">account / currency</th>
            <th className="p-3 text-right">payments</th>
            <th className="p-3 text-right">net</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {report.dimensions.map((row) => (
            <tr key={`${rowKey(row)}:${JSON.stringify(row.value)}`}>
              <td className="max-w-52 break-all p-3">{row.value ?? 'Unattributed'}</td>
              <td className="max-w-52 break-all p-3 text-muted-foreground">{namespace(row)}</td>
              <td className="p-3 text-right tabular-nums">{row.payments.toLocaleString()}</td>
              <td className="whitespace-nowrap p-3 text-right tabular-nums">
                {formatPaymentMinor(row.net_minor, row.currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Revenue({ query, ownerToken }: { query: RevenueScope; ownerToken: string }) {
  const [open, setOpen] = useState(false);
  const [basis, setBasis] = useState<'custom' | 'provider'>('custom');
  const [mode, setMode] = useState('live');
  const [breakdown, setBreakdown] = useState('source');
  const [revision, setRevision] = useState(0);
  const { report, error, loading } = useRevenue(query, ownerToken, open, mode, breakdown, {
    revision,
    basis,
  });
  return (
    <Card className="shadow-none">
      <CardHeader className="flex flex-wrap items-center justify-between gap-3 sm:flex-row">
        <div>
          <h2 className="text-sm font-semibold">revenue & payments</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            payments, refunds and their recorded attribution.
          </p>
        </div>
        <Button variant="outline" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? 'hide revenue' : 'explore revenue'}
        </Button>
      </CardHeader>
      {open ? (
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <LabeledSelect
              label="Revenue basis"
              value={basis}
              onValueChange={(value) => setBasis(value as typeof basis)}
              options={[
                { value: 'custom', label: 'custom · recorded cashflows' },
                { value: 'provider', label: 'providers · resource creation dates' },
              ]}
            />
            <LabeledSelect
              label="Payment mode"
              value={mode}
              onValueChange={setMode}
              options={[
                { value: 'live', label: 'live payments' },
                { value: 'test', label: 'test payments' },
              ]}
            />
            <LabeledSelect
              label="Revenue breakdown"
              value={breakdown}
              onValueChange={setBreakdown}
              options={['source', 'page', 'country', 'campaign'].map((value) => ({
                value,
                label: value,
              }))}
            />
            <Button
              variant="ghost"
              disabled={loading}
              onClick={() => setRevision((value) => value + 1)}
            >
              refresh revenue
            </Button>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            Revenue uses the selected period and payment mode. Traffic and event filters do not
            filter these financial facts.
          </p>
          {loading ? (
            <p role="status" className="text-xs text-muted-foreground">
              reading recorded payments…
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <RevenueResults report={report} provider={basis === 'provider'} />
        </CardContent>
      ) : null}
    </Card>
  );
}

function RevenueResults({
  report,
  provider,
}: {
  report: RevenueReportV1 | ProviderRevenueReportV1 | null;
  provider: boolean;
}) {
  return report ? (
    <>
      <p className="rounded-lg bg-muted p-3 text-xs leading-5 text-muted-foreground">
        {report.coverage_note}
      </p>
      <RevenueTotals rows={report.totals} provider={provider} />
      {!report.totals.length ? (
        <p className="text-sm text-muted-foreground">
          {provider
            ? 'No imported provider payments in this period and mode. Connect a provider in project settings and import its history.'
            : 'No recorded payments in this period and mode. Send explicit server payment facts through the private payments API.'}
        </p>
      ) : null}
      {'unresolved' in report && report.unresolved.length ? (
        <div role="status" className="rounded-lg border p-3 text-xs leading-5">
          <p className="font-medium">Unresolved provider resources</p>
          {report.unresolved.map((row) => (
            <p key={row.reason}>
              {row.count} · {row.reason.replaceAll('_', ' ')}
            </p>
          ))}
        </div>
      ) : null}
      <RevenueDimensions report={report} />
    </>
  ) : null;
}
