/** Shared bounded transport for Analytics Engine reports; callers validate their own rows. */
export async function browserQuery(
  sql: string,
  options: { accountId: string; token: string; fetchImpl?: typeof fetch },
): Promise<Response> {
  return (options.fetchImpl ?? fetch)(
    `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${options.token}`, 'content-type': 'text/plain' },
      body: sql,
      signal: AbortSignal.timeout(10000),
    },
  );
}
