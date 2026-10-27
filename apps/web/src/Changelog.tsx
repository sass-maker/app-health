import publicCopy from './public-copy.json';
import type { ReactElement } from 'react';
import { ProductBrand } from './ProductShell.js';
import { ThemeToggle } from './ThemeToggle.js';
import { Button } from '@saas-maker/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@saas-maker/ui/components/card';

const entries = publicCopy.entries;

export function Changelog(): ReactElement {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex min-h-16 max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <ProductBrand />
          <nav aria-label="Product links" className="flex items-center gap-2">
            <ThemeToggle />
            <Button asChild variant="ghost">
              <a href="https://github.com/sass-maker/app-health/issues">
                {publicCopy.changelog.roadmapLabel}
              </a>
            </Button>
            <Button asChild variant="outline">
              <a href="/app">{publicCopy.changelog.dashboardLabel}</a>
            </Button>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
        <p className="text-sm font-medium text-muted-foreground">{publicCopy.changelog.eyebrow}</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">{publicCopy.changelog.title}</h1>
        <p className="mt-4 text-base leading-7 text-muted-foreground">
          {publicCopy.changelog.summary}
        </p>
        <ol className="mt-8 space-y-6">
          {entries.map((entry) => (
            <li key={entry.date}>
              <Card>
                <CardHeader>
                  <time className="text-sm text-muted-foreground" dateTime={entry.date}>
                    {entry.date}
                  </time>
                  <CardTitle className="text-lg leading-7">{entry.title}</CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="list-disc space-y-2 pl-5 text-sm leading-6 text-muted-foreground">
                    {entry.outcomes.map((outcome) => (
                      <li key={outcome}>{outcome}</li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            </li>
          ))}
        </ol>
        <p className="mt-8 text-sm leading-6 text-muted-foreground">
          {publicCopy.changelog.analyticsDisclosure}
        </p>
      </main>
    </div>
  );
}
