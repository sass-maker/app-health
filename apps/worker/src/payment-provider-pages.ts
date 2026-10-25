import { providerGet } from './payment-provider-api.js';
import {
  object,
  resourceId,
  ProviderError,
  type JobRow,
  type ProviderSession,
} from './payment-provider-model.js';

export type ImportCursor = {
  page?: number;
  scannedPages?: number;
  lastCreated?: number;
  after?: string;
  ids?: string[];
  offset?: number;
  more?: boolean;
  last?: string;
  windowFrom?: number;
  windowTo?: number;
  pendingWindows?: [number, number][];
};
type PageRequest = { path: string; params: Record<string, string>; cursor: ImportCursor };
function stripeRequest(job: JobRow, cursor: ImportCursor): PageRequest {
  return {
    path: job.phase === 'refunds' ? '/refunds' : '/charges',
    cursor,
    params: {
      limit: '25',
      'created[gte]': String(Math.floor(job.from_time / 1000)),
      'created[lt]': String(Math.ceil(job.to_time / 1000)),
      ...(cursor.after ? { starting_after: cursor.after } : {}),
    },
  };
}
function polarRequest(session: ProviderSession, job: JobRow, cursor: ImportCursor): PageRequest {
  const refunds = job.phase === 'refunds';
  return {
    path: refunds ? '/refunds/' : '/orders/',
    cursor: { ...cursor, page: cursor.page ?? 1 },
    params: {
      limit: '25',
      page: String(cursor.page ?? 1),
      sorting: refunds ? '-created_at' : 'created_at',
      organization_id: session.connection.account_id,
      ...(!refunds
        ? {
            created_after: new Date(Math.max(0, job.from_time - 1)).toISOString(),
            created_before: new Date(job.to_time).toISOString(),
          }
        : {}),
    },
  };
}
function dodoRequest(session: ProviderSession, job: JobRow, cursor: ImportCursor): PageRequest {
  const page = cursor.page ?? 0,
    windowFrom = cursor.windowFrom ?? job.from_time,
    windowTo = cursor.windowTo ?? Math.min(windowFrom + 86400000, job.to_time);
  if (page >= 100) {
    if (windowTo - windowFrom <= 1000)
      throw new ProviderError('dodo_indivisible_dense_window_unsupported', 413);
    const middle = Math.floor((windowFrom + windowTo) / 2);
    return dodoRequest(session, job, {
      windowFrom,
      windowTo: middle,
      page: 0,
      pendingWindows: [...(cursor.pendingWindows ?? []), [middle, windowTo]],
    });
  }
  const refunds = job.phase === 'refunds';
  return {
    path: refunds ? '/refunds' : '/payments',
    cursor: { ...cursor, windowFrom, windowTo, page },
    params: {
      page_size: '25',
      page_number: String(page),
      created_at_gte: new Date(windowFrom).toISOString(),
      created_at_lte: new Date(windowTo).toISOString(),
      ...(!refunds && session.connection.selector ? { brand_id: session.connection.selector } : {}),
    },
  };
}
export async function providerPage(
  session: ProviderSession,
  job: JobRow,
  cursor: ImportCursor,
): Promise<ImportCursor> {
  const c = session.connection;
  const request =
    c.provider === 'stripe'
      ? stripeRequest(job, cursor)
      : c.provider === 'polar'
        ? polarRequest(session, job, cursor)
        : dodoRequest(session, job, cursor);
  const result = await providerGet(session, request.path, request.params);
  const rows = c.provider === 'stripe' ? result.data : result.items;
  if (!Array.isArray(rows) || rows.length > 25)
    throw new ProviderError('invalid_provider_page', 503);
  if (c.provider === 'polar' && job.phase === 'refunds')
    return polarRefundPage(request.cursor, rows, job);
  const ids = rows.map((row) => pageResourceId(c.provider, job.phase, object(row)));
  const more = c.provider === 'stripe' ? result.has_more === true : rows.length === 25;
  return { ...request.cursor, ids, offset: 0, more, last: ids.at(-1) };
}
function polarRefundPage(cursor: ImportCursor, rows: unknown[], job: JobRow): ImportCursor {
  const scannedPages = (cursor.scannedPages ?? 0) + 1;
  if (scannedPages > 4000) throw new ProviderError('polar_refund_history_scan_limit', 413);
  const ids: string[] = [];
  let lastCreated = cursor.lastCreated ?? Number.POSITIVE_INFINITY,
    pastWindow = false;
  for (const value of rows) {
    const row = object(value),
      id = resourceId(row.id),
      time = typeof row.created_at === 'string' ? Date.parse(row.created_at) : NaN;
    if (!Number.isFinite(time)) {
      ids.push(id);
      continue;
    }
    if (time > lastCreated) throw new ProviderError('polar_refund_ordering_unverified', 413);
    lastCreated = time;
    if (time < job.from_time) {
      pastWindow = true;
      continue;
    }
    if (time < job.to_time) ids.push(id);
  }
  return {
    ...cursor,
    scannedPages,
    lastCreated: Number.isFinite(lastCreated) ? lastCreated : undefined,
    ids,
    offset: 0,
    more: rows.length === 25 && !pastWindow,
  };
}
function pageResourceId(provider: string, phase: string, row: Record<string, unknown>) {
  if (provider !== 'dodo') return resourceId(row.id);
  return resourceId(row[phase === 'refunds' ? 'refund_id' : 'payment_id']);
}
export function nextImportPage(
  provider: ProviderSession['connection']['provider'],
  job: JobRow,
  cursor: ImportCursor,
): ImportCursor | null {
  if (cursor.more)
    return {
      page: (cursor.page ?? 0) + 1,
      after: cursor.last,
      scannedPages: cursor.scannedPages,
      lastCreated: cursor.lastCreated,
      windowFrom: cursor.windowFrom,
      windowTo: cursor.windowTo,
      pendingWindows: cursor.pendingWindows,
    };
  if (provider !== 'dodo') return null;
  const pending = [...(cursor.pendingWindows ?? [])],
    next = pending.pop();
  if (next) return { page: 0, windowFrom: next[0], windowTo: next[1], pendingWindows: pending };
  if (cursor.windowTo !== undefined && cursor.windowTo < job.to_time)
    return {
      page: 0,
      windowFrom: cursor.windowTo,
      windowTo: Math.min(cursor.windowTo + 86400000, job.to_time),
    };
  return null;
}
