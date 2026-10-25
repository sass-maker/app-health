import { ownerFetch } from './lib/owner-fetch.js';
import { BrowserTrafficPolicy } from './BrowserTrafficPolicy.js';
import {
  DailyEngagementReportV1,
  type DailyEngagementReportV1 as Report,
} from '@app-health/contracts';
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { CalendarDays, RefreshCw } from 'lucide-react';
import { Button } from '@saas-maker/ui/components/button';
import { CardContent } from '@saas-maker/ui/components/card';
import { Input } from '@saas-maker/ui/components/input';
import { CardSkeleton, StatTileSkeleton } from '@saas-maker/ui/blocks/skeletons';
import { DataTableSkeleton } from './components/ResourceTable.js';
import { SkeletonContainer } from '@saas-maker/ui/components/skeleton';
import { ErrorState } from '@saas-maker/ui/components/error-state';
import { EmptyState } from '@saas-maker/ui/components/empty-state';
import { FilterBar } from '@saas-maker/ui/blocks/filter-bar';
import { useResource } from '@saas-maker/ui/lib/use-resource';
import { accountResourceClient } from './lib/account-resource-client.js';
import type { PortfolioUsageProject } from './lib/portfolio-usage-export.js';
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
}): ReactElement {
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
        <p className="text-[11px] font-medium tracking-[0.18em] text-muted-foreground">
          completed India day
        </p>
        <h2
          id="daily-engagement-title"
          className="mt-2 text-2xl font-semibold tracking-[-0.035em] sm:text-3xl"
        >
          {dayLabel}
        </h2>
        <p className="mt-2 flex items-center gap-1.5 text-xs leading-5 text-muted-foreground">
          <CalendarDays className="size-3.5" /> what moved, where it came from, and what needs
          attention.
        </p>
      </div>
      <FilterBar className="items-end">
        <BrowserTrafficPolicy />
        <label className="grid gap-1 text-xs text-muted-foreground">
          report date
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
          latest
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onRefresh}
          aria-label="Refresh daily engagement"
          className="min-h-11"
        >
          <RefreshCw className="size-4" /> refresh
        </Button>
      </FilterBar>
    </header>
  );
}

interface ReportBodyProps {
  ownerToken: string;
  projects: PortfolioUsageProject[];
  loading: boolean;
  error: string;
  report: Report | null;
  onRetry: () => void;
  onOpenProduct?: (appId: string, focus?: ProductFocus, source?: string, date?: string) => void;
  attentionItems: PortfolioAttentionItem[];
  healthCoverage?: PortfolioHealthCoverage;
  projectHealth?: Record<string, PortfolioHealthState>;
}

function ReportBody(props: ReportBodyProps): ReactElement {
  const {
    ownerToken,
    projects,
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
      <SkeletonContainer aria-label="Loading daily engagement" className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          {[0, 1, 2].map((index) => (
            <StatTileSkeleton key={index} announce={false} />
          ))}
        </div>
        <CardSkeleton announce={false} className="min-h-52" />
        <DataTableSkeleton
          announce={false}
          rows={5}
          columns={[
            { id: 'product', header: 'product', minWidth: '12rem' },
            { id: 'visitors', header: 'browser visitors', align: 'right' },
            { id: 'actions', header: 'actions', align: 'right' },
            { id: 'responses', header: 'responses', align: 'right' },
          ]}
        />
      </SkeletonContainer>
    );
  if (error)
    return (
      <ErrorState
        title="daily report is unavailable"
        description={error}
        primaryAction={{ label: 'retry daily report', onClick: onRetry }}
      />
    );
  if (!report)
    return (
      <EmptyState
        title="no daily report for this date"
        primaryAction={{ label: 'try again', onClick: onRetry }}
      />
    );
  return (
    <PortfolioBriefing
      ownerToken={ownerToken}
      projects={projects}
      date={report.date}
      report={report}
      onOpenProduct={onOpenProduct}
      attentionItems={attentionItems}
      healthCoverage={healthCoverage}
      projectHealth={projectHealth}
      onCatalogLinked={onRetry}
    />
  );
}

interface DailyEngagementProps {
  ownerToken: string;
  projects?: PortfolioUsageProject[];
  onReport?: (report: Report | null) => void;
  onOpenProduct?: (appId: string, focus?: ProductFocus, source?: string, date?: string) => void;
  attentionItems?: PortfolioAttentionItem[];
  healthCoverage?: PortfolioHealthCoverage;
  projectHealth?: Record<string, PortfolioHealthState>;
}

export function DailyEngagement(props: DailyEngagementProps): ReactElement {
  const {
    ownerToken,
    projects = [],
    onReport,
    onOpenProduct,
    attentionItems = [],
    healthCoverage,
    projectHealth,
  } = props;
  const [date, setDate] = useState(previousReportDay);
  const [followsLatest, setFollowsLatest] = useState(true);
  const client = useMemo(() => accountResourceClient(ownerToken), [ownerToken]);
  const resource = useResource<Report>(
    `daily-engagement:${date}`,
    async (signal) => {
      const url = `/v1/reports/daily-engagement?date=${encodeURIComponent(date)}&capture_applicability=1&browser_visitor_unknown_reason=1&feedback_applicability=1`;
      const response = await ownerFetch(url, ownerToken, {
        signal,
        headers: ownerToken ? { authorization: `Bearer ${ownerToken}` } : {},
      });
      if (!response.ok) throw new Error(`daily report returned ${response.status}`);
      return DailyEngagementReportV1.parse(await response.json());
    },
    { client, staleTime: 0, retries: 0, revalidateOnFocus: false, revalidateOnReconnect: false },
  );
  const report = resource.data ?? null;
  const error = resource.error?.message ?? '';
  const loading = resource.status === 'loading';
  useEffect(() => {
    onReport?.(report);
  }, [onReport, report]);

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
        onRefresh={() => void resource.retry()}
      />
      <CardContent className="min-h-[40rem] space-y-6 p-0">
        <ReportBody
          ownerToken={ownerToken}
          projects={projects}
          loading={loading}
          error={error}
          report={report}
          onRetry={() => void resource.retry()}
          onOpenProduct={onOpenProduct}
          attentionItems={attentionItems}
          healthCoverage={healthCoverage}
          projectHealth={projectHealth}
        />
      </CardContent>
    </section>
  );
}
