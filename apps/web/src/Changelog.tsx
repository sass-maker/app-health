import { ProductBrand } from './ProductShell.js';
import { ThemeToggle } from './ThemeToggle.js';
import { Button } from './components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card.js';

const entries = [
  {
    date: '2026-07-27',
    title: 'One product key can now cover multiple environments',
    outcomes: [
      'SDK and OpenTelemetry traffic can select a bounded environment while sharing one product-scoped ingest key.',
      'The dashboard switches endpoint health, installation status, and retained failures together.',
    ],
  },
  {
    date: '2026-07-25',
    title: 'Cloudflare applications gained first-party adapters',
    outcomes: [
      'Hono middleware and a Pages Functions wrapper report trusted route templates without changing application responses.',
      'Delivery stays fail-open and can continue through the platform execution context after a response is returned.',
    ],
  },
  {
    date: '2026-07-22',
    title: 'The dashboard made collection boundaries visible',
    outcomes: [
      'Operators can inspect recent retained failures and the exact fields App Health accepts for an environment.',
      'The product explains aggregate storage, retention, and the request data it never collects.',
    ],
  },
  {
    date: '2026-07-21',
    title: 'Endpoint health reached production',
    outcomes: [
      'Node, Go, and OpenTelemetry traffic can feed the same focused view of requests, latency, errors, and last-seen time.',
      'Every accepted route remains discoverable even when sampled metrics are temporarily unavailable.',
    ],
  },
];

export function Changelog(): JSX.Element {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex min-h-16 max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <ProductBrand />
          <nav aria-label="Product links" className="flex items-center gap-2">
            <ThemeToggle />
            <Button asChild variant="ghost">
              <a href="https://github.com/sass-maker/app-health/issues">Roadmap</a>
            </Button>
            <Button asChild variant="outline">
              <a href="/app">Dashboard</a>
            </Button>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
        <p className="text-sm font-medium text-muted-foreground">Product history</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">
          What changed, and what it means.
        </h1>
        <p className="mt-4 text-base leading-7 text-muted-foreground">
          A curated record of shipped App Health outcomes. Roadmap work stays in GitHub Issues; this
          page records released capabilities.
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
          This public changelog uses Microsoft Clarity to understand navigation and rendering. The
          owner-key unlock and private dashboard never load it.
        </p>
      </main>
    </div>
  );
}
