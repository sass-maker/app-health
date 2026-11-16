import { expect, it } from 'vitest';
import { probeDefinitionRevision } from '../src/probe-revision.js';
const raw = { url: 'https://example.test', budget_ms: 2000 };
it('normalizes defaults, strips extras and includes every public request and expectation field', async () => {
  const digest = await probeDefinitionRevision(raw);
  expect(
    await probeDefinitionRevision({
      ...raw,
      url: 'https://example.test/',
      method: 'GET',
      timeout_ms: 8000,
      warm_check: false,
      expect: { status: 200, body_includes: [], json: [], first_party_asset: false },
      project: 'private',
      ownerNotes: 'secret',
    }),
  ).toBe(digest);
  for (const change of [
    { url: 'https://changed.test' },
    { method: 'POST', body: { b: 2, a: 1 } },
    { budget_ms: 3000 },
    { timeout_ms: 9000 },
    { warm_check: true },
    { expect: { status: 201 } },
    { expect: { content_type: 'text/html' } },
    { expect: { body_includes: ['marker'] } },
    { expect: { first_party_asset: true } },
    { expect: { json: [{ path: 'data', min_items: 1, equals: true, private: 'ignored' }] } },
  ])
    expect(await probeDefinitionRevision({ ...raw, ...change })).not.toBe(digest);
  expect(await probeDefinitionRevision({ ...raw, body: { b: 2, a: 1 } })).toBe(
    await probeDefinitionRevision({ ...raw, body: '{"a":1,"b":2}' }),
  );
  expect(
    await probeDefinitionRevision({ ...raw, expect: { json: 'invalid', content_type: 1 } }),
  ).toBe(digest);
});
it.each([30000, 30001, 40000, 60000])(
  'accepts the parser-normalized capped deadline for budget %d',
  async (budget) => {
    const definition = { ...raw, budget_ms: budget };
    expect(await probeDefinitionRevision({ ...definition, timeout_ms: 30000 })).toBe(
      await probeDefinitionRevision(definition),
    );
  },
);
it.each([
  null,
  [],
  { ...raw, budget_ms: 0 },
  { ...raw, budget_ms: 60001 },
  { ...raw, budget_ms: 2.5 },
  { ...raw, timeout_ms: 1 },
  { ...raw, budget_ms: 40000, timeout_ms: 29999 },
  { ...raw, budget_ms: 40000, timeout_ms: 35000 },
  { ...raw, timeout_ms: 60001 },
  { ...raw, timeout_ms: 2000.5 },
  { ...raw, url: 'https://user:pass@example.test' },
  { ...raw, url: 'https://example.test?secret=1' },
  { ...raw, url: 'ftp://example.test' },
  { ...raw, expect: { json: [null] } },
])('rejects invalid definitions %j', async (value) => {
  await expect(probeDefinitionRevision(value)).rejects.toThrow();
});
