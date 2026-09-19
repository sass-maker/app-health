import { describe, expect, it } from 'vitest';
import { CatalogImportRequestV1 } from '../src/catalog-import.js';

const project = { catalog_id: 'sample-project', name: 'Sample', lifecycle: 'active' };
const parse = (projects: unknown[]) =>
  CatalogImportRequestV1.safeParse({ schema_version: 1, projects });

describe('bounded catalog declarations', () => {
  it('preserves canonical metadata while defaulting omitted public locators to null', () => {
    expect(parse([project])).toMatchObject({
      success: true,
      data: { projects: [{ ...project, repository: null, hostname: null }] },
    });
    expect(
      parse([
        {
          ...project,
          repository: 'https://github.com/owner/repo',
          hostname: 'sub.example.com',
          existing_app_id: 'owned-project',
        },
      ]).success,
    ).toBe(true);
  });
  it('rejects duplicate identities, oversized batches, secrets and private URL components', () => {
    expect(parse([project, project]).success).toBe(false);
    expect(parse([]).success).toBe(false);
    expect(
      parse(Array.from({ length: 11 }, (_, n) => ({ ...project, catalog_id: `project-${n}` })))
        .success,
    ).toBe(false);
    for (const repository of [
      'https://secret@github.com/owner/repo',
      'https://github.com/owner/repo?token=secret',
      'https://other.test/owner/repo',
    ])
      expect(parse([{ ...project, repository }]).success).toBe(false);
    for (const hostname of [
      'https://example.com',
      'example.com/path',
      'example.com?secret',
      'localhost',
    ])
      expect(parse([{ ...project, hostname }]).success).toBe(false);
    expect(parse([{ ...project, token: 'secret' }]).success).toBe(false);
  });
});
