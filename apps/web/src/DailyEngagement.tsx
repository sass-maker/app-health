import { BrowserTrafficPolicy } from './BrowserTrafficPolicy.js';
import {
  DailyEngagementReportV1,
  type DailyEngagementReportV1 as Report,
} from '@app-health/contracts';
import { useEffect, useState } from 'react';
import { AlertTriangle, CalendarDays, RefreshCw } from 'lucide-react';
import { Button } from './components/ui/button.js';
import { CardContent } from './components/ui/card.js';
import { Input } from './components/ui/input.js';
import { Skeleton } from './components/ui/skeleton.js';
import {
  PortfolioBriefing,
  type PortfolioAttentionItem,
  type PortfolioHealthCoverage,
  type PortfolioHealthState,
} from './PortfolioBriefing.js';

type ProductFocus = 'analytics' | 'events' | 'backend';

function previousReportDay(): string {
  return new Date(Date.now() + 330 * 60_000 - 86_400_000).toISOString().slice(0, 10);
}

function nextIndiaDayBoundary(): number {
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  return Date.parse(`${today}T00:00:00Z`) + 86_400_000 - 330 * 60_000;
}

function ReportHeader({
  date,
  onDateChange,
  onRefresh,
  onLatest,
}: {
  date: string;
  onDateChange: (date: string) => void;
  onRefresh: () => void;
  onLatest: () => void;
}): JSX.Element {
  const dayLabel = new Date(`${date}T12:00:00+05:30`).toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });
  return (
    <header className="flex flex-col gap-5 border-b border-border/70 pb-6 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0">
        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Completed India day
        </p>
        <h2
          id="daily-engagement-title"
          className="mt-2 text-2xl font-semibold tracking-[-0.035em] sm:text-3xl"
        >
          {dayLabel}
        </h2>
        <p className="mt-2 flex items-center gap-1.5 text-xs leading-5 text-muted-foreground">
          <CalendarDays className="size-3.5" /> What moved, where it came from, and what needs
          attention.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <BrowserTrafficPolicy />
        <label className="grid gap-1 text-xs text-muted-foreground">
          Report date
          <Input
            type="date"
            value={date}
            max={previousReportDay()}
            onChange={(event) => onDateChange(event.target.value)}
            className="h-11 w-42"
          />
        </label>
        <Button
          type="button"
          variant="outline"
          onClick={onLatest}
          aria-label="Show latest completed day"
          className="min-h-11"
        >
          Latest
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onRefresh}
          aria-label="Refresh daily engagement"
          className="min-h-11"
        >
          <RefreshCw className="size-4" /> Refresh
        </Button>
      </div>
    </header>
  );
}

interface ReportBodyProps {
  ownerToken: string;
  loading: boolean;
  error: string;
  report: Report | null;
  onRetry: () => void;
  onOpenProduct?: (appId: string, focus?: ProductFocus, source?: string, date?: string) => void;
  attentionItems: PortfolioAttentionItem[];
  healthCoverage?: PortfolioHealthCoverage;
  projectHealth?: Record<string, PortfolioHealthState>;
}

function ReportBody(props: ReportBodyProps): JSX.Element {
  const {
    ownerToken,
    loading,
    error,
    report,
    onRetry,
    onOpenProduct,
    attentionItems,
    healthCoverage,
    projectHealth,
  } = props;
  if (loading)
    return (
      <div role="status" aria-label="Loading daily engagement" className="space-y-3">
        <Skeleton className="h-28 w-full rounded-xl" />
        <Skeleton className="h-52 w-full rounded-xl" />
        <Skeleton className="h-80 w-full rounded-xl" />
      </div>
    );
  if (error)
    return (
      <div
        role="alert"
        className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
      >
        <span className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          {error}
        </span>
        <Button type="button" variant="outline" className="min-h-11" onClick={onRetry}>
          Retry daily report
        </Button>
      </div>
    );
  if (!report) return <></>;
  return (
    <PortfolioBriefing
      ownerToken={ownerToken}
      date={report.date}
      report={report}
      onOpenProduct={onOpenProduct}
      attentionItems={attentionItems}
      healthCoverage={healthCoverage}
      projectHealth={projectHealth}
    />
  );
}

interface DailyEngagementProps {
  ownerToken: string;
  onReport?: (report: Report | null) => void;
  onOpenProduct?: (appId: string, focus?: ProductFocus, source?: string, date?: string) => void;
  attentionItems?: PortfolioAttentionItem[];
  healthCoverage?: PortfolioHealthCoverage;
  projectHealth?: Record<string, PortfolioHealthState>;
}

export function DailyEngagement(props: DailyEngagementProps): JSX.Element {
  const {
    ownerToken,
    onReport,
    onOpenProduct,
    attentionItems = [],
    healthCoverage,
    projectHealth,
  } = props;
  const [date, setDate] = useState(previousReportDay);
  const [followsLatest, setFollowsLatest] = useState(true);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!followsLatest) return;
    const syncDate = () => setDate(previousReportDay());
    let timer: ReturnType<typeof setTimeout>;
    const scheduleBoundary = () => {
      timer = setTimeout(
        () => {
          syncDate();
          scheduleBoundary();
        },
        Math.max(0, nextIndiaDayBoundary() - Date.now() + 25),
      );
    };
    const onFocus = () => syncDate();
    scheduleBoundary();
    window.addEventListener('focus', onFocus);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [followsLatest]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    onReport?.(null);
    const url = `/v1/reports/daily-engagement?date=${encodeURIComponent(date)}&capture_applicability=1&browser_visitor_unknown_reason=1`;
    void fetch(url, {
      signal: controller.signal,
      headers: ownerToken ? { authorization: `Bearer ${ownerToken}` } : {},
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Daily report returned ${response.status}`);
        return DailyEngagementReportV1.parse(await response.json());
      })
      .then((next) => {
        if (!controller.signal.aborted) {
          setReport(next);
          onReport?.(next);
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Daily report is unavailable');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [date, ownerToken, onReport, retry]);

  return (
    <section
      id="daily-engagement"
      aria-labelledby="daily-engagement-title"
      className="space-y-7 text-foreground"
    >
      <ReportHeader
        date={date}
        onDateChange={(nextDate) => {
          setFollowsLatest(false);
          setDate(nextDate);
        }}
        onLatest={() => {
          setFollowsLatest(true);
          setDate(previousReportDay());
        }}
        onRefresh={() => setRetry((value) => value + 1)}
      />
      <CardContent className="space-y-6 p-0">
        <ReportBody
          ownerToken={ownerToken}
          loading={loading}
          error={error}
          report={report}
          onRetry={() => setRetry((value) => value + 1)}
          onOpenProduct={onOpenProduct}
          attentionItems={attentionItems}
          healthCoverage={healthCoverage}
          projectHealth={projectHealth}
        />
      </CardContent>
    </section>
  );
}
