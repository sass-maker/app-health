import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { journeyKey, parseSpec, SpecError, type Expectation } from '../src/spec.ts';
import { firstPartyAsset, validateResponse } from '../src/validate.ts';
import type { HttpResult } from '../src/measure.ts';

const minimal = {
  project: 'anime-list',
  journey: 'home',
  url: 'https://example.com/',
  budget_ms: 2000,
};

describe('parseSpec', () => {
  it('accepts the catalog-generated policy, which is GET-only', () => {
    const spec = parseSpec(JSON.parse(readFileSync('journeys.json', 'utf8')));
    expect(spec.journeys.map(journeyKey)).toEqual(
      expect.arrayContaining([
        'app-health/home',
        'app-health/api-health',
        'anime-list/anime-stats',
      ]),
    );
    expect(spec.journeys.every((item) => item.method === 'GET' && item.body === undefined)).toBe(
      true,
    );
    expect(new Set(spec.journeys.map((item) => item.project)).size).toBeGreaterThan(2);
  });

  it('parses a fixed POST fixture', () => {
    const [journey] = parseSpec({
      schema_version: 1,
      journeys: [{ ...minimal, method: 'POST', body: { pagesize: 3 } }],
    }).journeys;
    expect(journey?.method).toBe('POST');
    expect(journey?.timeout_ms).toBe(8000);
    expect(JSON.parse(journey?.body ?? '{}')).toMatchObject({ pagesize: 3 });
  });

  it('applies defaults', () => {
    const [journey] = parseSpec({
      schema_version: 1,
      journeys: [{ ...minimal, budget_ms: 9000 }],
    }).journeys;
    expect(journey).toMatchObject({
      method: 'GET',
      timeout_ms: 30000,
      warm_check: false,
      expect: { status: 200, body_includes: [], json: [], first_party_asset: false },
    });
  });

  it.each([
    [null, 'spec: must be an object'],
    [{ schema_version: 2, journeys: [minimal] }, 'schema_version'],
    [{ schema_version: 1, journeys: [] }, 'non-empty'],
    [{ schema_version: 1, journeys: Array(201).fill(minimal) }, 'at most 200'],
    [{ schema_version: 1, journeys: [minimal, minimal] }, 'duplicate journey anime-list/home'],
    [{ schema_version: 1, journeys: [{ ...minimal, project: 'Anime' }] }, 'project'],
    [{ schema_version: 1, journeys: [{ ...minimal, url: 'http://example.com/' }] }, 'https'],
    [{ schema_version: 1, journeys: [{ ...minimal, url: 42 }] }, 'must be a URL'],
    [{ schema_version: 1, journeys: [{ ...minimal, url: 'not a url' }] }, 'must be a URL'],
    [{ schema_version: 1, journeys: [{ ...minimal, url: 'https://a:b@x.com/' }] }, 'credentials'],
    [{ schema_version: 1, journeys: [{ ...minimal, url: 'https://x.com/?q=1' }] }, 'query'],
    [{ schema_version: 1, journeys: [{ ...minimal, method: 'PUT' }] }, 'GET or POST'],
    [{ schema_version: 1, journeys: [{ ...minimal, body: {} }] }, 'only allowed for POST'],
    [
      {
        schema_version: 1,
        journeys: [{ ...minimal, method: 'POST', body: { a: 'x'.repeat(5000) } }],
      },
      'under 4096',
    ],
    [{ schema_version: 1, journeys: [{ ...minimal, method: 'POST', body: [] }] }, 'object'],
    [{ schema_version: 1, journeys: [{ ...minimal, budget_ms: 50 }] }, 'budget_ms'],
    [{ schema_version: 1, journeys: [{ ...minimal, timeout_ms: 10 }] }, 'timeout_ms'],
    [{ schema_version: 1, journeys: [{ ...minimal, expect: { status: 700 } }] }, 'status'],
    [{ schema_version: 1, journeys: [{ ...minimal, expect: { json: {} } }] }, 'must be a list'],
    [
      { schema_version: 1, journeys: [{ ...minimal, expect: { json: [{ path: 'a..b' }] } }] },
      'path',
    ],
    [
      {
        schema_version: 1,
        journeys: [{ ...minimal, expect: { json: [{ path: 'a', equals: {} }] } }],
      },
      'scalar',
    ],
    [
      { schema_version: 1, journeys: [{ ...minimal, expect: { body_includes: [''] } }] },
      'non-empty strings',
    ],
  ])('rejects %#', (value, message) => {
    expect(() => parseSpec(value)).toThrow(SpecError);
    expect(() => parseSpec(value)).toThrow(message);
  });

  it('allows plain http only for loopback test targets', () => {
    const spec = parseSpec({
      schema_version: 1,
      journeys: [{ ...minimal, url: 'http://127.0.0.1:8787/x', timeout_ms: 5000 }],
    });
    expect(spec.journeys[0]?.timeout_ms).toBe(5000);
  });
});

const response = (overrides: Partial<HttpResult>): HttpResult => ({
  status: 200,
  contentType: 'application/json; charset=utf-8',
  body: Buffer.from('{"ok":true,"data":{"items":[1,2]}}'),
  phases: { total_ms: 10 },
  ...overrides,
});
const expectation = {
  status: 200,
  content_type: 'application/json',
  body_includes: [],
  json: [],
  first_party_asset: false,
};

describe('validateResponse', () => {
  it('passes a complete usable result', () => {
    expect(
      validateResponse(response({}), {
        ...expectation,
        body_includes: ['"ok"'],
        json: [
          { path: 'ok', equals: true },
          { path: 'data.items', min_items: 2 },
          { path: 'data' },
        ],
      }),
    ).toEqual({});
  });

  it.each([
    [response({ failure: 'timeout' }), {}, { failure: 'timeout' }],
    [response({ status: 503 }), {}, { failure: 'http', detail: 'status 503' }],
    [response({ status: undefined }), {}, { failure: 'http', detail: 'status missing' }],
    [response({ contentType: 'text/html' }), {}, { failure: 'content_type' }],
    [response({ contentType: undefined }), {}, { failure: 'content_type' }],
    [
      response({}),
      { body_includes: ['absent'] },
      { failure: 'semantic', detail: 'body marker 0 missing' },
    ],
    [response({ body: Buffer.from('<html>') }), { json: [{ path: 'ok' }] }, { failure: 'parse' }],
    [response({ body: undefined }), { json: [{ path: 'ok' }] }, { failure: 'parse' }],
    [
      response({}),
      { json: [{ path: 'ok', min_items: 1 }] },
      { failure: 'semantic', detail: 'ok is not a list' },
    ],
    [
      response({}),
      { json: [{ path: 'data.items', min_items: 3 }] },
      { failure: 'semantic', detail: 'data.items has 2 of 3 required items' },
    ],
    [response({}), { json: [{ path: 'ok', equals: false }] }, { failure: 'semantic' }],
    [
      response({}),
      { json: [{ path: 'ok.deeper' }] },
      { failure: 'semantic', detail: 'ok.deeper is missing' },
    ],
  ] as Array<[HttpResult, Partial<Expectation>, object]>)(
    'fails case %#',
    (result, overrides, verdict) => {
      expect(validateResponse(result, { ...expectation, ...overrides })).toMatchObject(verdict);
    },
  );
});

describe('firstPartyAsset', () => {
  it('returns the first same-origin script or stylesheet', () => {
    const html = `<script src="https://cdn.other.com/x.js"></script>
      <link rel="icon" href="/favicon.ico">
      <script type="module" crossorigin src="/assets/main-1.js?v=2#frag"></script>`;
    expect(firstPartyAsset(html, 'https://app.example.com/page')).toBe(
      'https://app.example.com/assets/main-1.js?v=2',
    );
    expect(
      firstPartyAsset('<link rel="stylesheet" href="style.css">', 'https://a.com/dir/index.html'),
    ).toBe('https://a.com/dir/style.css');
  });

  it('returns undefined when no first-party asset is referenced', () => {
    expect(firstPartyAsset('<script src="https://x.com/a.js"></script>', 'https://a.com/')).toBe(
      undefined,
    );
    expect(firstPartyAsset('<script src="http://[bad"></script>', 'https://a.com/')).toBe(
      undefined,
    );
  });
});
