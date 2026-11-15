import { describe, expect, it } from 'vitest';
import {
  CatalogSyncRequestV1,
  CatalogSyncStatusV1,
  MAX_CATALOG_OUTSIDE_APPS,
  projectCanonicalCatalog,
} from '../src/catalog-sync.js';

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: 'alpha',
    name: 'Alpha',
    lifecycle: { status: 'archived', portfolioStatus: 'active' },
    classification: { kind: 'platform', futureForm: 'support-tool' },
    deployment: { authModel: 'local-only', domains: ['alpha.example.com'] },
    repositories: { url: 'https://github.com/example/alpha', localPath: '/private/canary' },
    ownerNotes: 'PRIVATE_CANARY',
    systems: {
      appHealth: {
        browserVisitors: { applicability: 'not-applicable' },
        nativeSessions: 'applicable',
        serverRequests: 'unknown',
      },
      probe: { journeys: [{ journey: 'home', url: 'https://private.invalid/canary' }] },
    },
    ...overrides,
  };
}
const catalog = (...projects: unknown[]) => ({
  catalogSchemaVersion: 2,
  projects,
  ownerNotes: 'PRIVATE_CANARY',
});
const input = () => projectCanonicalCatalog(catalog(project()), null);

describe('canonical portfolio projection', () => {
  it('selects explicit active membership and strips private source fields while preserving independent facets and actual metric forms', () => {
    const result = projectCanonicalCatalog(
      catalog(
        project(),
        project({
          id: 'retired',
          lifecycle: { status: 'active', portfolioStatus: 'archived' },
          classification: undefined,
          deployment: undefined,
          systems: undefined,
        }),
      ),
      'a'.repeat(64),
    );
    expect(result.projects).toEqual([
      {
        catalog_id: 'alpha',
        name: 'Alpha',
        kind: 'platform',
        future_form: 'support-tool',
        auth_model: 'local-only',
        repository: 'https://github.com/example/alpha',
        hostname: 'alpha.example.com',
        browser_visitors: 'not_applicable',
        native_sessions: 'applicable',
        server_requests: 'unknown',
      },
    ]);
    expect(result.monitoring.projects[0]).toEqual({
      catalog_id: 'alpha',
      name: 'Alpha',
      scope: 'public',
      reason: null,
      journeys: ['home'],
    });
    expect(result.expected_previous_hash).toBe('a'.repeat(64));
    expect(result.preserve_outside_catalog_app_ids).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE_CANARY|localPath|private.invalid|ownerNotes/,
    );
  });

  it('keeps local/private limits explicit and generic, normalizes object/string forms, and leaves unsupported metrics unknown', () => {
    const result = projectCanonicalCatalog(
      catalog(
        project({
          id: 'local',
          repositories: { url: 'file:///private/canary' },
          deployment: { authModel: 'private-authenticated', domains: ['invalid/path'] },
          systems: {
            appHealth: {
              browserVisitors: 'applicable',
              nativeSessions: { applicability: 'not-applicable' },
              serverRequests: { applicability: 'unsupported' },
            },
            probe: { scope: 'local', absent: 'PRIVATE_CANARY' },
          },
        }),
        project({
          id: 'private',
          systems: { probe: { scope: 'private', absent: 'PRIVATE_CANARY' } },
          repositories: undefined,
          deployment: { authModel: 'required-service' },
        }),
      ),
      null,
    );
    expect(result.projects[0]).toMatchObject({
      browser_visitors: 'applicable',
      native_sessions: 'not_applicable',
      repository: null,
      hostname: null,
    });
    expect(result.projects[0]?.server_requests).toBeUndefined();
    expect(result.projects[1]?.native_sessions).toBeUndefined();
    expect(result.monitoring.projects.map((row) => row.scope)).toEqual(['local', 'private']);
    expect(result.monitoring.projects.map((row) => row.reason)).toEqual([
      'Local project; public monitoring does not apply.',
      'Private project; public monitoring does not apply.',
    ]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_CANARY');
  });

  it.each([{ classification: undefined }, { deployment: undefined }])(
    'rejects missing active classification %j',
    (override) => {
      expect(() => projectCanonicalCatalog(catalog(project(override)), null)).toThrow(
        'Missing classification',
      );
    },
  );
  it.each([
    undefined,
    {},
    { scope: 'local' },
    { absent: 'private' },
    { journeys: [] },
    { scope: 'local', journeys: [{ journey: 'home' }] },
    { absent: 'private', journeys: [{ journey: 'home' }] },
  ])('rejects missing or ambiguous monitoring %j', (probe) => {
    expect(() => projectCanonicalCatalog(catalog(project({ systems: { probe } })), null)).toThrow(
      /monitoring|coverage/,
    );
  });
  it('rejects duplicate identities, legacy-only membership, unknown statuses and incompatible schema versions', () => {
    expect(() => projectCanonicalCatalog(catalog(project(), project()), null)).toThrow(
      'Duplicate catalog identity',
    );
    for (const invalid of [
      { ...catalog(project()), catalogSchemaVersion: 1 },
      catalog(project({ lifecycle: { status: 'active' } })),
      catalog(project({ lifecycle: { portfolioStatus: 'paused' } })),
      catalog(project({ lifecycle: { portfolioStatus: 'archived' } })),
    ])
      expect(() => projectCanonicalCatalog(invalid, null)).toThrow();
    expect(() => projectCanonicalCatalog(catalog(project({ systems: undefined })), null)).toThrow(
      'monitoring declaration',
    );
  });
});

describe('portfolio synchronization contracts', () => {
  it('requires the same unique catalog and monitoring cohort and names', () => {
    const duplicate = input();
    duplicate.projects.push(duplicate.projects[0]!);
    expect(CatalogSyncRequestV1.safeParse(duplicate).success).toBe(false);
    const subset = input();
    subset.monitoring.projects = [];
    expect(CatalogSyncRequestV1.safeParse(subset).success).toBe(false);
    const extra = input();
    extra.monitoring.projects.push({ ...extra.monitoring.projects[0]!, catalog_id: 'extra' });
    expect(CatalogSyncRequestV1.safeParse(extra).success).toBe(false);
    const foreign = input();
    foreign.monitoring.projects[0]!.catalog_id = 'foreign';
    expect(CatalogSyncRequestV1.safeParse(foreign).success).toBe(false);
    const renamed = input();
    renamed.monitoring.projects[0]!.name = 'Other name';
    expect(CatalogSyncRequestV1.safeParse(renamed).success).toBe(false);
    const repeated = input();
    repeated.monitoring.projects[0]!.journeys = ['home', 'home'];
    expect(CatalogSyncRequestV1.safeParse(repeated).success).toBe(false);
  });
  it('rejects raw source fields, caller app IDs, malformed hashes and identities', () => {
    expect(CatalogSyncRequestV1.safeParse({ ...input(), ownerNotes: 'private' }).success).toBe(
      false,
    );
    const claimed = input();
    expect(
      CatalogSyncRequestV1.safeParse({
        ...claimed,
        projects: [{ ...claimed.projects[0], existing_app_id: 'app-owned' }],
      }).success,
    ).toBe(false);
    expect(
      CatalogSyncRequestV1.safeParse({ ...input(), expected_previous_hash: 'not-a-hash' }).success,
    ).toBe(false);
    expect(() =>
      projectCanonicalCatalog(catalog(project({ id: 'Invalid/identity' })), null),
    ).toThrow();
  });
  it('bounds source size, current cohorts and outside acknowledgements consistently with owner preview status', () => {
    expect(() =>
      projectCanonicalCatalog(
        catalog(...Array.from({ length: 1001 }, (_, index) => project({ id: `project-${index}` }))),
        null,
      ),
    ).toThrow();
    expect(() =>
      projectCanonicalCatalog(
        catalog(...Array.from({ length: 61 }, (_, index) => project({ id: `project-${index}` }))),
        null,
      ),
    ).toThrow();
    const acknowledged = input();
    acknowledged.preserve_outside_catalog_app_ids = Array.from(
      { length: MAX_CATALOG_OUTSIDE_APPS },
      (_, index) => `outside-${index}`,
    );
    expect(CatalogSyncRequestV1.safeParse(acknowledged).success).toBe(true);
    const status = {
      source: null,
      projection_hash: null,
      project_count: null,
      updated_at: null,
      mapped_catalog_ids: ['alpha'],
      unlinked_apps: acknowledged.preserve_outside_catalog_app_ids.map((app_id) => ({
        app_id,
        name: app_id,
      })),
    };
    expect(CatalogSyncStatusV1.safeParse(status).success).toBe(true);
    expect(
      CatalogSyncStatusV1.safeParse({
        ...status,
        unlinked_apps: [...status.unlinked_apps, { app_id: 'extra', name: 'Extra' }],
      }).success,
    ).toBe(false);
    acknowledged.preserve_outside_catalog_app_ids.push('extra');
    expect(CatalogSyncRequestV1.safeParse(acknowledged).success).toBe(false);
    acknowledged.preserve_outside_catalog_app_ids = ['duplicate', 'duplicate'];
    expect(CatalogSyncRequestV1.safeParse(acknowledged).success).toBe(false);
  });
});
