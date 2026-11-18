import type { BrowserReportFilter } from '@app-health/contracts';
import { browserReportPlan } from './browser-report-plan.js';
import {
  currentRankingCounter,
  trendRankingCounter,
  agreesWithCurrentPeriod,
  prepareJointRankings,
  foldJointRankings,
  validPageControl,
  jointControlsAgree,
} from './browser-report-joint.js';
import { assertProviderDeadline, queryJointRows } from './browser-report-transport.js';
import type { QueryOptions, QueryRow } from './browser-report-query-types.js';

type Arguments = {
  plan: ReturnType<typeof browserReportPlan>;
  filter: BrowserReportFilter;
  from: number;
  to: number;
  run: (index: number, options?: QueryOptions) => Promise<QueryRow[]>;
  options: QueryOptions;
};
function fallbackRankings(args: Arguments, joint: AbortController) {
  const controller = new AbortController();
  let pending: Promise<QueryRow[][]> | undefined;
  let resolve!: (rows: Promise<QueryRow[][]>) => void;
  const decided = new Promise<QueryRow[][]>((done) => {
    resolve = done;
  });
  const start = () => {
    if (!pending) {
      assertProviderDeadline(args.options);
      if (args.options.timings) args.options.timings.analyticsJointFallbacks = 1;
      joint.abort(new DOMException('Original rankings selected', 'AbortError'));
      // Dispatch may trail the speculative read by up to the watchdog budget.
      // Original ranking reads still get their own ten seconds.
      const options = {
        ...args.options,
        signal: controller.signal,
        deadlineAt: performance.now() + 10_000,
      };
      const timer = setTimeout(
        () => controller.abort(new DOMException('Analytics deadline elapsed', 'TimeoutError')),
        10_000,
      );
      pending = Promise.all([3, 5, 6, 7].map((index) => args.run(index, options)))
        .catch((error) => {
          controller.abort(error);
          throw error;
        })
        .finally(() => clearTimeout(timer));
      resolve(pending);
    }
    return pending;
  };
  return {
    start,
    decided,
    started: () => pending !== undefined,
    cancel: (error: unknown) => controller.abort(error),
  };
}
function jointWatchdog(fallback: ReturnType<typeof fallbackRankings>, controller: AbortController) {
  const timeout = setTimeout(() => {
    try {
      fallback.start();
    } catch (error) {
      controller.abort(error);
    }
  }, 2_000);
  return () => clearTimeout(timeout);
}
/** Start the bounded speculative read immediately; validation only controls acceptance. */
export async function eagerReportRows(args: Arguments): Promise<QueryRow[][]> {
  const controller = new AbortController();
  const fallback = fallbackRankings(args, controller);
  const counts: Record<string, ReturnType<typeof currentRankingCounter>> = {};
  let prepared: ReturnType<typeof prepareJointRankings>;
  let pageControl: QueryRow[] | undefined;
  const reconcile = () => {
    if (
      prepared &&
      (!jointControlsAgree(prepared, counts.trend, pageControl) ||
        !jointControlsAgree(prepared, counts.current))
    )
      fallback.start();
  };
  const observe = (key: string, count: ReturnType<typeof currentRankingCounter>) => {
    counts[key] = count;
    const other = counts[key === 'trend' ? 'current' : 'trend'];
    if (!count || (other && (other.pageviews !== count.pageviews || other.events !== count.events)))
      fallback.start();
    reconcile();
  };
  const trend = args.run(0).then((rows) => {
    observe('trend', trendRankingCounter(rows));
    return rows;
  });
  const pages = args.run(1).then((rows) => {
    pageControl = rows;
    if (!validPageControl(rows)) fallback.start();
    reconcile();
    return rows;
  });
  const sources = args.run(2);
  const periods = args.run(4).then((rows) => {
    observe('current', currentRankingCounter(rows));
    return rows;
  });
  const stopWatchdog = jointWatchdog(fallback, controller);
  const joint = queryJointRows(args.plan.jointSql!, args.options, controller).then((data) => {
    prepared = prepareJointRankings({
      data,
      filter: args.filter,
      from: args.from,
      to: args.to,
      dimensions: args.plan.dimensionBlobs,
    });
    if (!prepared) fallback.start();
    reconcile();
    return prepared;
  });
  const fixed = Promise.all([trend, pages, periods]);
  const acceptance = Promise.all([fixed, joint]).then(([controls, rows]) => {
    assertProviderDeadline(args.options);
    if (fallback.started()) return fallback.start();
    const counter = trendRankingCounter(controls[0]);
    const folded =
      rows && counter && agreesWithCurrentPeriod(controls[2], counter)
        ? foldJointRankings({
            folded: rows,
            counter,
            trend: controls[0],
            pages: controls[1],
          })
        : undefined;
    stopWatchdog();
    return folded ? [folded.events, ...folded.dimensions] : fallback.start();
  });
  try {
    const [controls, sourceRows, rankings] = await Promise.all([
      fixed,
      sources,
      Promise.race([acceptance, fallback.decided]),
    ]);
    return [controls[0], controls[1], sourceRows, rankings[0], controls[2], ...rankings.slice(1)];
  } catch (error) {
    fallback.cancel(error);
    throw error;
  } finally {
    stopWatchdog();
  }
}
