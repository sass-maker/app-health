import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { URL } from 'node:url';
import { minify } from 'terser';

const source = new URL('./tracker-source.js', import.meta.url);
const output = new URL('../public/tracker.js', import.meta.url);
const result = await minify(await readFile(source, 'utf8'), {
  compress: { passes: 2 },
  mangle: true,
  format: {
    preamble: '// Edit scripts/tracker-source.js',
  },
});
if (!result.code) throw new Error('Tracker generation produced no code');
const code = `${result.code}\n`;
if (process.argv.includes('--check')) {
  if ((await readFile(output, 'utf8')) !== code)
    throw new Error('Tracker is stale. Run node scripts/build-tracker.mjs.');
} else await writeFile(output, code);
