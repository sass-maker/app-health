import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL, URL } from 'node:url';
import postcss from 'postcss';

const host = ':where(studio-footer)';
const roots = [':root', ':host', ':where(:root)'];
const inheritedFonts = new Set(['--font-sans', '--font-display', '--font-mono']);
const vendorHash = '0965de83182b14016dc682b6e16e100b4a1428e80b4271b797205bdc332725a5';

/** Keep the vendored footer's utilities local and its root theme on the element itself. */
export function scopeFooterCss(source) {
  const root = postcss.parse(source);
  root.walkRules((rule) => {
    for (let parent = rule.parent; parent; parent = parent.parent) {
      if (parent.type === 'atrule' && /(^|-)keyframes$/.test(parent.name)) return;
      // CSS nesting already inherits the enclosing rule's host scope.
      if (parent.type === 'rule') return;
    }
    const selectors = postcss.list.comma(rule.selector);
    if (selectors.every((selector) => roots.includes(selector)))
      rule.walkDecls((declaration) => {
        if (declaration.value.replace(/\s/g, '') === `var(${declaration.prop})`)
          declaration.remove();
        else if (inheritedFonts.has(declaration.prop))
          // Local defaults must retain App Health's established root font tokens.
          declaration.value = 'inherit';
      });
    rule.selector = [
      ...new Set(
        selectors.flatMap((selector) => {
          if (roots.includes(selector)) return [host];
          if (selector.includes('studio-footer')) return [selector];
          if (selector.includes(':root') || selector.includes(':host'))
            throw new Error(`Review unsupported footer root selector: ${selector}`);
          if (/^\[data-(?:theme|mode|surface)=/.test(selector))
            return [`${host}${selector}`, `${host} ${selector}`];
          return [`${host} ${selector}`];
        }),
      ),
    ].join(',');
  });
  // This utility is used by the vendored markup but missing from its CSS bundle.
  return `${root.toString()}\n@layer utilities{@media(min-width:640px){${host} .sm\\:flex-1{flex:1}}}\n`;
}

function build(check) {
  const source = readFileSync(new URL('../vendor/footer.css', import.meta.url));
  if (createHash('sha256').update(source).digest('hex') !== vendorHash)
    throw new Error('Review the upstream footer stylesheet before updating its source hash.');
  const generated = scopeFooterCss(source.toString());
  const target = new URL('../public/footer.css', import.meta.url);
  if (check) {
    if (readFileSync(target, 'utf8') !== generated)
      throw new Error('Footer CSS is stale; run node scripts/build-footer-css.mjs.');
  } else writeFileSync(target, generated);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  build(process.argv.includes('--check'));
