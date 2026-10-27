import type { ReactElement } from 'react';
import copy from './public-copy.json';
import { ProductBrand } from './ProductShell.js';
import { ThemeToggle } from './ThemeToggle.js';
import { Button } from '@saas-maker/ui/components/button';

const { privacy } = copy;

export function PrivacyPage(): ReactElement {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex min-h-16 max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <ProductBrand />
          <nav aria-label="Product links" className="flex items-center gap-2">
            <ThemeToggle />
            <Button asChild variant="outline">
              <a href="/">home</a>
            </Button>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
        <p className="text-sm text-muted-foreground">{privacy.updated}</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">{privacy.title}</h1>
        <p className="mt-4 leading-7 text-muted-foreground">{privacy.summary}</p>
        <div className="mt-10 space-y-8">
          {privacy.sections.map(([title, description]) => (
            <section key={title}>
              <h2 className="text-lg font-semibold">{title}</h2>
              <p className="mt-3 text-sm leading-7 text-muted-foreground">{description}</p>
            </section>
          ))}
        </div>
        <p className="mt-8 text-sm leading-7">
          {privacy.contactLabel}{' '}
          <a className="underline underline-offset-4" href={`mailto:${privacy.email}`}>
            {privacy.email}
          </a>
        </p>
      </main>
    </div>
  );
}
