/** Digest only the public request and its reviewed checks. */
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid public check definition');
  return value as Record<string, unknown>;
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]),
    );
  return value;
}
function budgetFields(raw: Record<string, unknown>) {
  const budget = raw.budget_ms;
  const timeout = raw.timeout_ms ?? Math.min(30000, Math.max(8000, Number(budget) * 4));
  if (
    !Number.isInteger(budget) ||
    Number(budget) < 100 ||
    Number(budget) > 60000 ||
    !Number.isInteger(timeout) ||
    Number(timeout) < Number(budget) ||
    Number(timeout) > 60000
  )
    throw new Error('Invalid public check budget');
  return { budget_ms: budget, timeout_ms: timeout };
}
function publicUrl(value: unknown) {
  const url = new URL(String(value));
  if (url.username || url.password || url.search || !['https:', 'http:'].includes(url.protocol))
    throw new Error('Invalid public check URL');
  return url.toString();
}
export async function probeDefinitionRevision(value: unknown): Promise<string> {
  const raw = object(value);
  const expect = object(raw.expect ?? {});
  const body = typeof raw.body === 'string' ? JSON.parse(raw.body) : raw.body;
  const definition = {
    url: publicUrl(raw.url),
    method: raw.method ?? 'GET',
    body,
    ...budgetFields(raw),
    warm_check: raw.warm_check === true,
    expect: {
      status: expect.status ?? 200,
      content_type: typeof expect.content_type === 'string' ? expect.content_type : undefined,
      body_includes: expect.body_includes ?? [],
      json: Array.isArray(expect.json)
        ? expect.json.map((item) => {
            const check = object(item);
            return { path: check.path, min_items: check.min_items, equals: check.equals };
          })
        : [],
      first_party_asset: expect.first_party_asset === true,
    },
  };
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(stable(definition))),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
