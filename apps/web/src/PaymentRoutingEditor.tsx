import { useState } from 'react';
import type { PaymentConnection, PaymentRoutingInput } from '@app-health/contracts';
import { Button } from '@saas-maker/ui/components/button';
import { Input } from '@saas-maker/ui/components/input';
import { LabeledSelect } from './LabeledSelect.js';

type Project = { appId: string; environmentId: string; name: string; environment: string };
export function PaymentRoutingEditor({
  connection,
  projects,
  busy,
  save,
}: {
  connection: PaymentConnection;
  projects: Project[];
  busy: boolean;
  save: (input: PaymentRoutingInput) => void;
}) {
  const [routing, setRouting] = useState(connection.routing),
    [rules, setRules] = useState(connection.rules);
  const [product, setProduct] = useState(''),
    [destination, setDestination] = useState(`${connection.app_id}|${connection.environment_id}`);
  function add() {
    const [app_id, environment_id] = destination.split('|');
    if (!product.trim() || rules.length >= 100) return;
    setRules([
      ...rules.filter((rule) => rule.product_id !== product.trim()),
      { product_id: product.trim(), app_id, environment_id },
    ]);
    setProduct('');
  }
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <LabeledSelect
        label="Payment routing"
        value={routing}
        onValueChange={(value) => setRouting(value as typeof routing)}
        options={[
          { value: 'exclusive', label: 'whole account · this environment' },
          { value: 'products', label: 'product allowlists · whole transaction' },
        ]}
      />
      <p className="text-xs leading-5 text-muted-foreground">
        Every product in a cart must identify one destination. Mixed, unmapped or unavailable
        product evidence stays unresolved. Existing payment assignments and their refunds keep their
        original destination.
      </p>
      {routing === 'products' ? (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              aria-label="Provider product ID"
              placeholder={connection.fixture ? 'fixture-product' : 'provider product ID'}
              value={product}
              onChange={(event) => setProduct(event.target.value)}
            />
            <LabeledSelect
              label="Product destination"
              value={destination}
              onValueChange={setDestination}
              options={projects.map((project) => ({
                value: `${project.appId}|${project.environmentId}`,
                label: `${project.name} · ${project.environment}`,
              }))}
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !product.trim() || rules.length >= 100}
            onClick={add}
          >
            add product rule
          </Button>
          <ul className="space-y-2 text-xs">
            {rules.map((rule) => (
              <li
                className="flex flex-wrap items-center justify-between gap-2"
                key={rule.product_id}
              >
                <span className="min-w-0 break-all">
                  {rule.product_id} →{' '}
                  {projects.find(
                    (project) =>
                      project.appId === rule.app_id &&
                      project.environmentId === rule.environment_id,
                  )?.name ?? rule.app_id}{' '}
                  /{' '}
                  {projects.find((project) => project.environmentId === rule.environment_id)
                    ?.environment ?? rule.environment_id}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove product ${rule.product_id}`}
                  onClick={() =>
                    setRules(rules.filter((value) => value.product_id !== rule.product_id))
                  }
                >
                  remove
                </Button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <Button
        size="sm"
        variant="outline"
        disabled={busy || connection.status !== 'active'}
        onClick={() => save({ routing, rules: routing === 'products' ? rules : [] })}
      >
        save routing
      </Button>
    </div>
  );
}
