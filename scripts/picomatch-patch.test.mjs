import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

// Resolve the same installed dependency copy used by the workspace tooling.
const requireFromKnip = createRequire(
  realpathSync(new URL('../node_modules/knip/package.json', import.meta.url)),
);
const picomatch = requireFromKnip('picomatch');

test('the patched parser rejects repeated wildcard branches before building a matcher', () => {
  const unsupported = 'src/+(widget*).ts';
  for (const options of [{}, { maxExtglobRecursion: false }]) {
    assert.throws(() => picomatch.parse(unsupported, options), {
      name: 'SyntaxError',
      message: /single repeated extglob/,
    });
  }
});

test('repo-style glob filters and literal extglobs remain supported', () => {
  for (const [pattern, match] of [
    ['src/**/*.ts', 'src/lib/file.ts'],
    ['src/@(client|server).ts', 'src/client.ts'],
    ['file-+(a|b).ts', 'file-ab.ts'],
  ]) {
    assert.equal(picomatch(pattern)(match), true, pattern);
    assert.equal(picomatch(pattern)('other.txt'), false, pattern);
  }
});
