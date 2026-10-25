import { useState, type FormEvent } from 'react';
import type { PaymentCredentials, PaymentProvider } from '@app-health/contracts';
import { Button } from '@saas-maker/ui/components/button';
import { Input } from '@saas-maker/ui/components/input';
import { LabeledSelect } from './LabeledSelect.js';

export function PaymentCredentialsForm({
  provider,
  fixture,
  busy,
  onSubmit,
  label = 'connect provider',
}: {
  provider: PaymentProvider;
  fixture: boolean;
  busy: boolean;
  onSubmit: (credentials: PaymentCredentials | undefined) => void;
  label?: string;
}) {
  const [apiKey, setApiKey] = useState(''),
    [webhook, setWebhook] = useState(''),
    [previous, setPrevious] = useState('');
  const [scheme, setScheme] = useState<'standard' | 'polar_legacy'>('standard');
  function submit(event: FormEvent) {
    event.preventDefault();
    const credentials = fixture
      ? undefined
      : {
          api_key: apiKey,
          webhook_secrets: [webhook, ...(previous ? [previous] : [])],
          signature_scheme: scheme,
        };
    setApiKey('');
    setWebhook('');
    setPrevious('');
    onSubmit(credentials);
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      {fixture ? (
        <p className="rounded-md bg-muted p-3 text-xs">
          Fixed local test fixture. No credentials or real provider connection.
        </p>
      ) : (
        <>
          <label className="grid gap-1.5 text-xs">
            Provider API key
            <Input
              aria-label="Provider API key"
              type="password"
              autoComplete="off"
              required
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
          <label className="grid gap-1.5 text-xs">
            Webhook signing secret
            <Input
              aria-label="Webhook signing secret"
              type="password"
              autoComplete="off"
              required
              value={webhook}
              onChange={(event) => setWebhook(event.target.value)}
            />
          </label>
          <label className="grid gap-1.5 text-xs">
            Previous signing secret · optional during rotation
            <Input
              aria-label="Previous signing secret"
              type="password"
              autoComplete="off"
              value={previous}
              onChange={(event) => setPrevious(event.target.value)}
            />
          </label>
          {provider === 'polar' ? (
            <LabeledSelect
              label="Polar signature scheme"
              value={scheme}
              onValueChange={(value) => setScheme(value as typeof scheme)}
              options={[
                { value: 'standard', label: 'standard · created September 8, 2026 or later' },
                { value: 'polar_legacy', label: 'legacy · created before September 8, 2026' },
              ]}
            />
          ) : null}
          <p className="text-xs leading-5 text-muted-foreground">
            Secrets clear on submission and are encrypted on the server. Replacing credentials must
            resolve to the same account and mode.
          </p>
        </>
      )}
      <Button type="submit" disabled={busy}>
        {label}
      </Button>
    </form>
  );
}
