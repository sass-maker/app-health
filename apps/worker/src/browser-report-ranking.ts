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
  run: (index: number) => Promise<QueryRow[]>;
  options: QueryOptions;
};
function fallbackRankings(args: Arguments, joint: AbortController) {
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
      pending = Promise.all([3, 5, 6, 7].map(args.run));
      resolve(pending);
    }
    return pending;
  };
  return { start, decided, started: () => pending !== undefined };
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
  const joint = queryJointRows(args.plan.jointSql!, args.options, controller)
    .then((data) => {
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
    })
    .finally(stopWatchdog);
  const fixed = Promise.all([trend, pages, sources, periods]);
  const acceptance = Promise.all([fixed, joint]).then(([controls, rows]) => {
    assertProviderDeadline(args.options);
    if (fallback.started()) return fallback.start();
    const counter = trendRankingCounter(controls[0]);
    const folded =
      rows && counter && agreesWithCurrentPeriod(controls[3], counter)
        ? foldJointRankings({
            folded: rows,
            counter,
            trend: controls[0],
            pages: controls[1],
          })
        : undefined;
    return folded ? [folded.events, ...folded.dimensions] : fallback.start();
  });
  try {
    const [controls, rankings] = await Promise.all([
      fixed,
      Promise.race([acceptance, fallback.decided]),
    ]);
    assertProviderDeadline(args.options);
    return [controls[0], controls[1], controls[2], rankings[0], controls[3], ...rankings.slice(1)];
  } finally {
    stopWatchdog();
  }
}
