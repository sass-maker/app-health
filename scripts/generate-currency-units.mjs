import { readFile, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
const source = await readFile(
  new URL('../packages/contracts/src/currency-minor-units.ts', import.meta.url),
  'utf8',
);
const entries = [...source.matchAll(/^ {2}([A-Z]{3}): (\d),/gm)];
if (entries.length < 150) throw new Error('Incomplete canonical ISO currency table');
await writeFile(
  new URL('../packages/go/currency_units.go', import.meta.url),
  '// Code generated from packages/contracts/src/currency-minor-units.ts; DO NOT EDIT.\npackage apphealth\n\nvar productCurrencyUnits = map[string]int{\n' +
    entries.map(([, key, value]) => `\t"${key}": ${value},\n`).join('') +
    '}\n',
);
