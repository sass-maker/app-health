import assert from 'node:assert/strict';
import test from 'node:test';
import { boundTsxFunctionLength } from './lizard-tsx-spans.mjs';
const line = (file = 'sample.tsx', name = 'Sample') =>
  `200,42,55,9,200,"${name}@1-200@${file}","${file}","${name}","${name} ()",1,200`;
const row = [200, 42, 55, 9, 200];
const source =
  'export function Sample() {\n  return <p>Visible copy</p>;\n}\nfunction Later() { return null; }';
test('caps a merged JSX span to its unique actual function without lowering complexity or parameters', () => {
  assert.deepEqual(
    boundTsxFunctionLength(line(), row, () => source),
    [200, 42, 55, 9, 3],
  );
  assert.deepEqual(row, [200, 42, 55, 9, 200]);
});
test('leaves non-JSX, anonymous, ambiguous and already-bounded rows unchanged', () => {
  const neverRead = () => {
    throw new Error('not a JSX declaration');
  };
  assert.equal(boundTsxFunctionLength(line('sample.ts'), row, neverRead), row);
  assert.equal(boundTsxFunctionLength(line('sample.tsx', '(anonymous)'), row, neverRead), row);
  assert.equal(
    boundTsxFunctionLength(line(), row, () => source + '\nfunction Sample() {}'),
    row,
  );
  const short = [1, 42, 55, 9, 1];
  assert.equal(
    boundTsxFunctionLength(line(), short, () => source),
    short,
  );
});
