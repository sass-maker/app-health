import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import { scopeFooterCss } from './build-footer-css.mjs';

test('the committed footer is reproducible and keeps existing host selectors usable', () => {
  const source = readFileSync(new URL('../vendor/footer.css', import.meta.url), 'utf8');
  const generated = scopeFooterCss(source);
  assert.equal(generated, readFileSync(new URL('../public/footer.css', import.meta.url), 'utf8'));
  assert.ok(generated.includes(':where(studio-footer){font-family:var(--font-sans)'));
  assert.ok(!generated.includes(':where(studio-footer) :where(studio-footer)'));
});

test('dark and named themes apply to both the footer host and its themed descendants', () => {
  const generated = scopeFooterCss('[data-mode=dark]{color:white}[data-theme=paper]{color:black}');
  assert.ok(
    generated.includes(
      ':where(studio-footer)[data-mode=dark],:where(studio-footer) [data-mode=dark]',
    ),
  );
  assert.ok(
    generated.includes(
      ':where(studio-footer)[data-theme=paper],:where(studio-footer) [data-theme=paper]',
    ),
  );
});

test('root font families inherit existing product tokens without cyclic custom properties', () => {
  const generated = scopeFooterCss(
    ':root{--font-sans:system-ui;--font-display:serif;--font-mono:monospace;--font-text:var(--font-text);--font-weight-bold:700}',
  );
  assert.ok(generated.includes('--font-sans:inherit'));
  assert.ok(generated.includes('--font-display:inherit'));
  assert.ok(generated.includes('--font-mono:inherit'));
  assert.ok(!generated.includes('--font-text:'));
  assert.ok(generated.includes('--font-weight-bold:700'));
});

test('nested selectors and animation frames retain their existing relative semantics', () => {
  const generated = scopeFooterCss(
    '.card{&:hover{color:red}}@keyframes pulse{from{opacity:0}to{opacity:1}}',
  );
  assert.ok(generated.includes(':where(studio-footer) .card{&:hover{color:red}}'));
  assert.ok(generated.includes('@keyframes pulse{from{opacity:0}to{opacity:1}}'));
});

test('unexpected composite root selectors require review instead of leaking global styles', () => {
  assert.throws(
    () => scopeFooterCss(':root:not(.dark) .card{color:red}'),
    /unsupported footer root selector/,
  );
});
