import {
  Activity,
  ArrowRight,
  BarChart3,
  Check,
  Code2,
  MousePointer2,
  Radio,
  Sparkles,
  Zap,
} from 'lucide-react';
import { AnalyticsChart } from './AnalyticsChart.js';
import { ThemeToggle } from './ThemeToggle.js';
import { ProductBrand } from './ProductShell.js';
import { Badge } from './components/ui/badge.js';
import { Button } from './components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card.js';
import { Separator } from './components/ui/separator.js';

const sample = [
  12, 18, 14, 25, 20, 35, 28, 44, 32, 38, 54, 48, 64, 43, 58, 76, 64, 80, 72, 92, 78, 98, 89, 110,
].map((value, index) => ({
  timestamp: Date.UTC(2026, 8, 11, index),
  pageviews: value,
  events: Math.round(value / 5),
}));

const proofPoints = [
  'Page views from one browser script',
  'Named events with one line',
  'App health when you need context',
];

function PreviewMetric({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="min-w-0 px-4 py-4 sm:px-5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl">{value}</p>
      <p className="mt-1 text-xs leading-4 text-muted-foreground">{note}</p>
    </div>
  );
}

function ProductPreview(): JSX.Element {
  const pages = [
    ['/pricing', '482'],
    ['/', '391'],
    ['/docs', '248'],
  ];
  const events = [
    ['signup.completed', '142'],
    ['checkout.started', '86'],
    ['project.created', '35'],
  ];
  return (
    <Card
      aria-label="Illustrative web analytics preview"
      className="relative overflow-hidden border-border/80 bg-card/90 shadow-2xl shadow-black/15"
    >
      <div className="absolute inset-x-0 top-0 h-px bg-primary/70" />
      <CardHeader className="flex flex-row items-center justify-between gap-4 border-b py-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="relative flex size-2.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-50" />
            <span className="relative inline-flex size-2.5 rounded-full bg-emerald-400" />
          </span>
          <CardTitle className="truncate text-sm">acme.app</CardTitle>
        </div>
        <Badge variant="outline" className="font-normal text-muted-foreground">
          Illustrative data · 24h
        </Badge>
      </CardHeader>
      <CardContent className="p-0">
        <div className="grid grid-cols-3 divide-x divide-border border-b">
          <PreviewMetric label="Page views" value="1,313" note="Pages opened" />
          <PreviewMetric label="Product events" value="263" note="Actions tracked" />
          <PreviewMetric label="Active now" value="12" note="Browser sessions" />
        </div>
        <div className="px-3 py-5 sm:px-5">
          <AnalyticsChart series={sample} compact />
        </div>
        <div className="grid gap-px border-t bg-border sm:grid-cols-2">
          <PreviewList label="Top pages" rows={pages} />
          <PreviewList label="Product events" rows={events} />
        </div>
      </CardContent>
    </Card>
  );
}

function PreviewList({ label, rows }: { label: string; rows: string[][] }) {
  return (
    <div className="bg-card p-5">
      <p className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </p>
      {rows.map(([name, value]) => (
        <div
          key={name}
          className="flex items-center justify-between border-t py-2.5 text-xs first:border-0"
        >
          <span className="truncate font-mono text-foreground/90">{name}</span>
          <span className="ml-3 tabular-nums text-muted-foreground">{value}</span>
        </div>
      ))}
    </div>
  );
}

function Hero(): JSX.Element {
  return (
    <section className="relative overflow-hidden px-4 pb-20 pt-10 sm:px-6 sm:pb-28 sm:pt-16 lg:px-8">
      <div aria-hidden="true" className="landing-grid absolute inset-0 opacity-60" />
      <div className="relative mx-auto max-w-7xl">
        <div className="max-w-4xl">
          <Badge variant="secondary" className="mb-5 gap-2 px-3 py-1.5 font-medium">
            <Sparkles className="size-3.5 text-primary" />
            For people shaping digital products
          </Badge>
          <h1 className="max-w-4xl text-balance text-4xl font-semibold leading-[0.98] tracking-[-0.055em] sm:text-6xl lg:text-[5rem]">
            See what people do.
            <span className="block text-muted-foreground">Know what to improve.</span>
          </h1>
          <p className="mt-5 max-w-2xl text-pretty text-base leading-7 text-muted-foreground sm:text-lg sm:leading-8">
            App Health brings web analytics and meaningful product events into one calm workspace,
            with application health close by when the experience needs investigation.
          </p>
          <div className="mt-6 flex gap-3">
            <Button asChild size="lg" className="h-12 px-6">
              <a href="/app">
                Open App Health <ArrowRight />
              </a>
            </Button>
            <Button asChild size="lg" variant="outline" className="hidden h-12 px-6 sm:inline-flex">
              <a href="#product">Explore the product</a>
            </Button>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline" className="font-normal">
              Local preview available
            </Badge>
            <code className="rounded bg-muted px-2 py-1">&lt;script src="/tracker.js"&gt;</code>
            <code className="rounded bg-muted px-2 py-1">track('signup.completed')</code>
          </div>
        </div>
        <div className="mt-8 lg:ml-auto lg:mt-10 lg:w-[72%]">
          <ProductPreview />
        </div>
        <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2 lg:justify-end">
          {proofPoints.map((point) => (
            <span
              key={point}
              className="inline-flex items-center gap-2 text-xs text-muted-foreground"
            >
              <Check className="size-3.5 text-emerald-400" />
              {point}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

const features = [
  {
    icon: BarChart3,
    eyebrow: 'Web analytics',
    title: 'Find the pages earning attention.',
    body: 'Follow page views over time, see where visits come from, and move between one product and your whole workspace.',
    proof: 'Top pages · Referral sources · 24-hour trends',
  },
  {
    icon: MousePointer2,
    eyebrow: 'Product events',
    title: 'Measure the moments you choose.',
    body: 'Name the actions that matter to your product. Open any event to see its trend, pages, and referral sources.',
    proof: 'Event count · Last seen · Event drill-down',
  },
  {
    icon: Activity,
    eyebrow: 'Application health',
    title: 'Bring evidence to the handoff.',
    body: 'When product activity changes, inspect route traffic, latency, errors, and logs without leaving the workspace.',
    proof: 'Observed routes · Latency · Errors · Logs',
  },
];

function ProductSections(): JSX.Element {
  return (
    <section id="product" className="border-y bg-muted/25 px-4 py-20 sm:px-6 sm:py-28 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="grid gap-8 lg:grid-cols-[0.85fr_1.15fr] lg:items-end">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
              One product picture
            </p>
            <h2 className="mt-4 max-w-xl text-balance text-4xl font-semibold tracking-[-0.04em] sm:text-5xl">
              A visit is only the beginning.
            </h2>
          </div>
          <p className="max-w-2xl text-pretty text-base leading-7 text-muted-foreground lg:justify-self-end lg:text-lg">
            See how attention turns into action, then understand the application behind it. App
            Health keeps the story connected without pretending browser sessions are unique people.
          </p>
        </div>
        <div className="mt-14 grid gap-4 lg:grid-cols-3">
          {features.map((feature, index) => (
            <Card key={feature.title} className="group bg-card/70 transition-colors hover:bg-card">
              <CardHeader className="pb-4">
                <div className="flex items-center justify-between">
                  <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <feature.icon className="size-5" />
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">0{index + 1}</span>
                </div>
                <p className="pt-5 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  {feature.eyebrow}
                </p>
                <CardTitle className="text-2xl leading-tight tracking-tight">
                  {feature.title}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="min-h-24 text-sm leading-6 text-muted-foreground">{feature.body}</p>
                <Separator className="my-5" />
                <p className="font-mono text-xs leading-5 text-foreground/70">{feature.proof}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

function IntegrationSection(): JSX.Element {
  return (
    <section id="integration" className="px-4 py-20 sm:px-6 sm:py-28 lg:px-8">
      <div className="mx-auto grid max-w-7xl gap-12 lg:grid-cols-[0.85fr_1.15fr] lg:items-center">
        <div>
          <Badge variant="outline" className="gap-2">
            <Code2 className="size-3.5" /> Small by design
          </Badge>
          <h2 className="mt-6 text-balance text-4xl font-semibold tracking-[-0.04em] sm:text-5xl">
            From a product question to a clearer answer.
          </h2>
          <p className="mt-6 max-w-xl text-base leading-7 text-muted-foreground">
            Add one browser snippet for automatic page views, then send named events for the actions
            your team cares about. The tracker stays isolated from your application.
          </p>
          <Button asChild size="lg" className="mt-8 h-12">
            <a href="/app">
              Add your project <ArrowRight />
            </a>
          </Button>
        </div>
        <Card className="overflow-hidden bg-zinc-950 text-zinc-100 shadow-xl dark:bg-zinc-950">
          <CardHeader className="flex flex-row items-center justify-between border-b border-white/10 py-4">
            <div className="flex items-center gap-2 text-xs text-zinc-400">
              <span className="size-2 rounded-full bg-emerald-400" /> your-website.html
            </div>
            <Badge className="bg-white/10 text-zinc-300 hover:bg-white/10">Browser</Badge>
          </CardHeader>
          <CardContent className="p-0">
            <pre className="overflow-x-auto p-5 text-xs leading-6 sm:p-7 sm:text-sm">
              <code>{`<script defer
  src="https://YOUR_HOST/tracker.js"
  data-key="YOUR_PUBLIC_KEY"
  data-endpoint="https://YOUR_HOST/v1/browser"
></script>

window.appHealth.track('signup.completed')`}</code>
            </pre>
            <div className="flex flex-wrap gap-x-5 gap-y-2 border-t border-white/10 px-5 py-4 text-xs text-zinc-400 sm:px-7">
              <span className="inline-flex items-center gap-1.5">
                <Zap className="size-3" /> Named events
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Radio className="size-3" /> Active sessions
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Activity className="size-3" /> Backend health
              </span>
            </div>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

function HonestStatus(): JSX.Element {
  return (
    <section className="border-y bg-primary text-primary-foreground">
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-14 sm:px-6 lg:grid-cols-[1fr_auto] lg:items-center lg:px-8">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] opacity-70">
            Built in the open
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight">
            A useful first picture, with honest edges.
          </h2>
          <p className="mt-3 max-w-3xl text-sm leading-6 opacity-75">
            Web analytics and event exploration are available in the local product. Hosted Google
            sign-in and production analytics activation remain separate verification steps.
          </p>
        </div>
        <Button asChild size="lg" variant="secondary" className="h-12">
          <a href="/changelog">
            See what shipped <ArrowRight />
          </a>
        </Button>
      </div>
    </section>
  );
}

export function LandingPage(): JSX.Element {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-4 sm:px-6 lg:px-8">
          <ProductBrand />
          <nav aria-label="Main navigation" className="ml-auto hidden items-center gap-6 md:flex">
            <a
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
              href="#product"
            >
              Product
            </a>
            <a
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
              href="#integration"
            >
              Integration
            </a>
            <a
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
              href="/changelog"
            >
              Changelog
            </a>
          </nav>
          <div className="ml-auto flex items-center gap-2 md:ml-0">
            <ThemeToggle />
            <Button asChild size="sm" className="hidden sm:inline-flex">
              <a href="/app">
                Open dashboard <ArrowRight />
              </a>
            </Button>
          </div>
        </div>
      </header>
      <main>
        <Hero />
        <ProductSections />
        <IntegrationSection />
        <HonestStatus />
      </main>
      <footer className="border-t px-4 py-8 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-5 text-xs text-muted-foreground sm:flex-row sm:items-center">
          <ProductBrand />
          <span>A Fleet product for people who build products.</span>
          <a className="sm:ml-auto hover:text-foreground" href="/changelog">
            Changelog
          </a>
          <a className="hover:text-foreground" href="/privacy">
            Privacy
          </a>
        </div>
      </footer>
    </div>
  );
}
