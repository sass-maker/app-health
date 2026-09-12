import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sources = JSON.parse(readFileSync(resolve(root, 'docs/shadcn-sources.json'), 'utf8'));

// Only pinned upstream components are outside authored-code metric budgets.
// They still participate in lint, type checking, build, and interaction tests.
export const shadcnVendorPaths = sources.map(({ path }) => path);

export function checkShadcnVendor() {
  const seen = new Set();
  for (const source of sources) {
    const expectedPath =
      source.component === 'use-mobile'
        ? 'apps/web/src/hooks/use-mobile.ts'
        : `apps/web/src/components/ui/${source.component}.tsx`;
    if (
      !/^[a-z-]+$/.test(source.component) ||
      source.path !== expectedPath ||
      seen.has(source.path)
    )
      throw new Error('Invalid or duplicate shadcn source boundary');
    if (
      source.source !== `https://ui.shadcn.com/r/styles/new-york-v4/${source.component}.json` ||
      !/^[a-f0-9]{64}$/.test(source.upstreamSha256)
    )
      throw new Error(`Missing upstream provenance: ${source.path}`);
    const hash = createHash('sha256')
      .update(readFileSync(resolve(root, source.path)))
      .digest('hex');
    if (hash !== source.localSha256)
      throw new Error(`Review shadcn adaptation and update its source manifest: ${source.path}`);
    seen.add(source.path);
  }
  for (const file of readdirSync(resolve(root, 'apps/web/src/components/ui'))) {
    if (file.endsWith('.tsx') && !seen.has(`apps/web/src/components/ui/${file}`))
      throw new Error(`Unrecorded shadcn component: ${file}`);
  }
}
