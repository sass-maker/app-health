import publicCopy from './public-copy.json';
import { createElement, lazy, Suspense, useEffect, useState, type ReactElement } from 'react';
import { redirectSignedInLanding, type LandingSessionOptions } from './landing-session.js';
import {
  Activity,
  ArrowRight,
  BarChart3,
  Check,
  Code2,
  MousePointer2,
  Radio,
  Zap,
} from 'lucide-react';
import { ThemeToggle } from './ThemeToggle.js';
import { ProductBrand } from './ProductShell.js';
import { Badge } from '@saas-maker/ui/components/badge';
import { Button } from '@saas-maker/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@saas-maker/ui/components/card';
import { Separator } from '@saas-maker/ui/components/separator';

const sample = publicCopy.samplePageviews.map((value, index) => ({
  timestamp: Date.UTC(2026, 8, 11, index),
  pageviews: value,
  events: Math.round(value / 5),
}));

const proofPoints = publicCopy.proofPoints;

const AnalyticsChart = lazy(() =>
  import('./AnalyticsChart.js').then(({ AnalyticsChart }) => ({ default: AnalyticsChart })),
);

function PreviewMetric({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="min-w-0 px-4 py-4 sm:px-5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl">{value}</p>
      <p className="mt-1 text-xs leading-4 text-muted-foreground">{note}</p>
    </div>
  );
}

function ProductPreview(): ReactElement {
  const [showChart, setShowChart] = useState(false);
  useEffect(() => setShowChart(true), []);
  const pages = publicCopy.pages;
  const events = publicCopy.events;
  return (
    <Card
      aria-label="Illustrative web analytics preview"
      className="overflow-hidden border-border bg-card shadow-sm"
    >
      <CardHeader className="flex flex-row items-center justify-between gap-4 border-b py-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-2.5">
            <span className="m-auto size-2 rounded-full bg-success" />
          </span>
          <CardTitle className="truncate text-sm">{publicCopy.preview.name}</CardTitle>
        </div>
        <Badge variant="outline" className="font-normal text-muted-foreground">
          {publicCopy.preview.disclosure}
        </Badge>
      </CardHeader>
      <CardContent className="p-0">
        <div className="grid grid-cols-3 divide-x divide-border border-b">
          {publicCopy.previewMetrics.map((metric) => (
            <PreviewMetric key={metric.label} {...metric} />
          ))}
        </div>
        <div className="px-3 py-5 sm:px-5">
          {showChart ? (
            <Suspense fallback={<div className="h-44 w-full" aria-hidden="true" />}>
              <AnalyticsChart series={sample} compact />
            </Suspense>
          ) : (
            <div className="h-44 w-full" aria-hidden="true" />
          )}
        </div>
        <div className="grid gap-px border-t bg-border sm:grid-cols-2">
          <PreviewList label="top pages" rows={pages} />
          <PreviewList label="product events" rows={events} />
        </div>
      </CardContent>
    </Card>
  );
}

function PreviewList({ label, rows }: { label: string; rows: string[][] }) {
  return (
    <div className="bg-card p-5">
      <p className="mb-3 text-xs font-semibold  tracking-[0.16em] text-muted-foreground">{label}</p>
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

function Hero(): ReactElement {
  return (
    <section className="relative overflow-hidden px-4 pb-20 pt-10 sm:px-6 sm:pb-28 sm:pt-16 lg:px-8">
      <div className="relative mx-auto max-w-7xl">
        <div className="max-w-4xl">
          <Badge variant="secondary" className="mb-5 px-3 py-1.5 font-medium">
            {publicCopy.hero.audience}
          </Badge>
          <h1 className="max-w-4xl text-balance text-4xl font-semibold leading-[0.98] tracking-[-0.055em] sm:text-6xl lg:text-[5rem]">
            {publicCopy.hero.title}
            <span className="block text-muted-foreground">{publicCopy.hero.titleContinuation}</span>
          </h1>
          <p className="mt-5 max-w-2xl text-pretty text-base leading-7 text-muted-foreground sm:text-lg sm:leading-8">
            {publicCopy.hero.summary}
          </p>
          <div className="mt-6 flex gap-3">
            <Button asChild size="lg" className="h-12 px-6">
              <a href="/app" data-app-health-event="dashboard_opened">
                {publicCopy.hero.openLabel}
                <ArrowRight />
              </a>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="hidden h-12 px-6 sm:!inline-flex"
            >
              <a href="#product" data-app-health-event="product_explored">
                {publicCopy.hero.exploreLabel}
              </a>
            </Button>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline" className="font-normal">
              {publicCopy.hero.availability}
            </Badge>
            <code className="rounded bg-muted px-2 py-1">{publicCopy.hero.scriptExample}</code>
            <code className="rounded bg-muted px-2 py-1">{publicCopy.hero.eventExample}</code>
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
              <Check className="size-3.5 text-muted-foreground" />
              {point}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

const features = publicCopy.features.map((feature, index) => ({
  ...feature,
  icon: [BarChart3, MousePointer2, Activity][index],
}));

function ProductSections(): ReactElement {
  return (
    <section id="product" className="border-y bg-muted/25 px-4 py-20 sm:px-6 sm:py-28 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="grid gap-8 lg:grid-cols-[0.85fr_1.15fr] lg:items-end">
          <div>
            <p className="text-xs font-semibold  tracking-[0.18em] text-primary">
              {publicCopy.productSection.eyebrow}
            </p>
            <h2 className="mt-4 max-w-xl text-balance text-4xl font-semibold tracking-[-0.04em] sm:text-5xl">
              {publicCopy.productSection.title}
            </h2>
          </div>
          <p className="max-w-2xl text-pretty text-base leading-7 text-muted-foreground lg:justify-self-end lg:text-lg">
            {publicCopy.productSection.summary}
          </p>
        </div>
        <div className="mt-14 grid gap-4 lg:grid-cols-3">
          {features.map((feature, index) => (
            <Card key={feature.title} className="group bg-card/70 transition-colors hover:bg-card">
              <CardHeader className="pb-4">
                <div className="flex items-center justify-between">
                  <span className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <feature.icon className="size-5" />
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">0{index + 1}</span>
                </div>
                <p className="pt-5 text-xs font-semibold  tracking-[0.14em] text-muted-foreground">
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

function IntegrationSection(): ReactElement {
  return (
    <section id="integration" className="px-4 py-20 sm:px-6 sm:py-28 lg:px-8">
      <div className="mx-auto grid max-w-7xl gap-12 lg:grid-cols-[0.85fr_1.15fr] lg:items-center">
        <div>
          <Badge variant="outline" className="gap-2">
            <Code2 className="size-3.5" />
            {publicCopy.integration.eyebrow}
          </Badge>
          <h2 className="mt-6 text-balance text-4xl font-semibold tracking-[-0.04em] sm:text-5xl">
            {publicCopy.integration.title}
          </h2>
          <p className="mt-6 max-w-xl text-base leading-7 text-muted-foreground">
            {publicCopy.integration.summary}
          </p>
          <Button asChild size="lg" className="mt-8 h-12">
            <a href="/app" data-app-health-event="project_add_started">
              {publicCopy.integration.actionLabel}
              <ArrowRight />
            </a>
          </Button>
        </div>
        <Card className="overflow-hidden border bg-card text-card-foreground shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between border-b border-border py-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="size-2 rounded-full bg-success" />
              {publicCopy.integration.filename}
            </div>
            <Badge variant="secondary">{publicCopy.integration.platform}</Badge>
          </CardHeader>
          <CardContent className="p-0">
            <pre className="overflow-x-auto p-5 text-xs leading-6 sm:p-7 sm:text-sm">
              <code>{publicCopy.integrationSnippet}</code>
            </pre>
            <div className="flex flex-wrap gap-x-5 gap-y-2 border-t border-border px-5 py-4 text-xs text-muted-foreground sm:px-7">
              <span className="inline-flex items-center gap-1.5">
                <Zap className="size-3" />
                {publicCopy.integration.namedEvents}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Radio className="size-3" />
                {publicCopy.integration.activeSessions}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Activity className="size-3" />
                {publicCopy.integration.backendHealth}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

function HonestStatus(): ReactElement {
  return (
    <section className="border-y bg-primary text-primary-foreground">
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-14 sm:px-6 lg:grid-cols-[1fr_auto] lg:items-center lg:px-8">
        <div>
          <p className="text-xs font-semibold  tracking-[0.18em] opacity-70">
            {publicCopy.status.eyebrow}
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight">{publicCopy.status.title}</h2>
          <p className="mt-3 max-w-3xl text-sm leading-6 opacity-75">{publicCopy.status.summary}</p>
        </div>
        <Button asChild size="lg" variant="secondary" className="h-12">
          <a href="/changelog">
            {publicCopy.status.changelogLabel}
            <ArrowRight />
          </a>
        </Button>
      </div>
    </section>
  );
}

interface StudioFooterElement extends HTMLElement {
  config: Record<string, unknown>;
}

const footerConfig = {
  product: 'App Health',
  url: 'https://health.sassmaker.com',
  summary: 'a Fleet product for people who build products.',
  catalogId: 'app-health',
  capture: 'newsletter',
  variant: 'studio',
  art: {
    src: '/footer-art/app-health.webp',
    alt: 'original App Health illustration',
    position: '50% 50%',
  },
  groups: [
    {
      title: 'product',
      links: [
        { label: 'changelog', href: '/changelog' },
        { label: 'privacy', href: '/privacy' },
      ],
    },
  ],
  privacyUrl: '/privacy',
};

/** The framework-free SaaS Maker footer; its stylesheet and element load on the landing page only. */
function ProductFooter(): ReactElement {
  useEffect(() => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/footer.css';
    const script = document.createElement('script');
    script.type = 'module';
    script.src = '/footer.js';
    // Library gap: flex-1 collapses the stacked email field to its content height below 640px.
    const fix = document.createElement('style');
    fix.textContent = '@media (max-width:639px){studio-footer input[name="email"]{flex:none}}';
    document.head.append(link, script, fix);
    const syncTheme = () => {
      const element = document.querySelector('studio-footer');
      if (!element) return;
      if (document.documentElement.dataset.theme === 'light') element.removeAttribute('data-mode');
      else element.setAttribute('data-mode', 'dark');
    };
    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => {
      observer.disconnect();
      link.remove();
      script.remove();
      fix.remove();
    };
  }, []);
  return createElement('studio-footer', {
    ref: (element: StudioFooterElement | null) => {
      if (element) element.config = footerConfig;
    },
  });
}

export function LandingPage(props: LandingSessionOptions = {}): ReactElement {
  useEffect(() => {
    const controller = new AbortController();
    void redirectSignedInLanding(props.fetchImpl ?? fetch, props.navigate, controller.signal);
    return () => controller.abort();
  }, [props.fetchImpl, props.navigate]);
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b bg-background">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-4 sm:px-6 lg:px-8">
          <ProductBrand />
          <nav aria-label="Main navigation" className="ml-auto hidden items-center gap-6 md:!flex">
            <a
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
              href="#product"
            >
              product
            </a>
            <a
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
              href="#integration"
            >
              integration
            </a>
            <a
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
              href="/changelog"
              data-app-health-event="release_status_opened"
            >
              changelog
            </a>
          </nav>
          <div className="ml-auto flex items-center gap-2 md:ml-0">
            <ThemeToggle />
            <Button asChild size="sm" className="hidden sm:!inline-flex">
              <a href="/app">
                open dashboard <ArrowRight />
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
      <ProductFooter />
    </div>
  );
}
