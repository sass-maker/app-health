import { useCallback, useEffect, useState } from 'react';
import { PaymentConnection, type PaymentScopeV1 } from '@app-health/contracts';
import { ownerFetch } from './lib/owner-fetch.js';

export async function paymentProviderRequest(
  path: string,
  token: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await ownerFetch(path, token, {
    method,
    signal: signal ?? AbortSignal.timeout(25000),
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      typeof result.error === 'string'
        ? result.error.replaceAll('_', ' ').slice(0, 120)
        : 'Payment provider action unavailable',
    );
  return result;
}
export function paymentScopeQuery(scope: PaymentScopeV1) {
  return new URLSearchParams(scope).toString();
}
export function usePaymentConnections(scope: PaymentScopeV1, token: string) {
  const key = JSON.stringify([scope, token]);
  const [state, setState] = useState<{
    key: string;
    connections: PaymentConnection[];
    fixture: boolean;
  }>({ key: '', connections: [], fixture: false });
  const [revision, setRevision] = useState(0),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void paymentProviderRequest(
      `/v1/payment-connections?${paymentScopeQuery(scope)}`,
      token,
      'GET',
      undefined,
      controller.signal,
    )
      .then((value) => {
        const result = value as { connections: unknown[]; fixture_mode?: boolean };
        const connections = result.connections.map((row) => PaymentConnection.parse(row));
        if (!controller.signal.aborted)
          setState({ key, connections, fixture: result.fixture_mode === true });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError('Payment connections could not load. Try refreshing.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [scope.app_id, scope.environment_id, token, key, revision]);
  return {
    connections: state.key === key ? state.connections : [],
    fixture: state.key === key && state.fixture,
    loading,
    error,
    refresh,
  };
}
