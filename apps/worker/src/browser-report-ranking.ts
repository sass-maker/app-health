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
      pending = Promise.all([2, 3, 5, 6, 7].map(args.run));
      resolve(pending);
    }
    return pending;
  };
  return { start, decided, started: () => pending !== undefined };
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
  const periods = args.run(4).then((rows) => {
    observe('current', currentRankingCounter(rows));
    return rows;
  });
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
    return folded ? [folded.sources, folded.events, ...folded.dimensions] : fallback.start();
  });
  const [controls, rankings] = await Promise.all([
    fixed,
    Promise.race([acceptance, fallback.decided]),
  ]);
  assertProviderDeadline(args.options);
  return [controls[0], controls[1], rankings[0], rankings[1], controls[2], ...rankings.slice(2)];
}
