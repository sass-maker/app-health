// V1 application log contract. Unlike endpoint telemetry, logs are explicit,
// owner-authored events an application chooses to send ("signup",
// "waitlist.join", "payment.failed"). They carry whatever the owner puts in
// them, so they are an opt-in surface, retained for a bounded window, and
// never derived from request traffic.

import { z } from 'zod';
import { SCHEMA_VERSION } from './constants.js';
import { EnvironmentName } from './setup.js';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Where a log came from. Server logs are facts; browser logs are claims. */
export const LOG_SOURCES = ['server', 'browser', 'native'] as const;
export type LogSource = (typeof LOG_SOURCES)[number];
export const LogSourceField = z.enum(LOG_SOURCES);

/** Public (browser) log keys carry this prefix so ingest can tell them apart. */
export const PUBLIC_LOG_KEY_PREFIX = 'ahk_pub_';
/** Browser logs accepted per public key per minute. */
export const BROWSER_LOGS_PER_MINUTE = 600;
export const MAX_ALLOWED_ORIGINS = 20;

/** Maximum logs accepted in a single batch. */
export const MAX_LOG_BATCH = 100;
/** Maximum length of a log event name. */
export const MAX_LOG_EVENT_LENGTH = 64;
/** Maximum length of a log title. */
export const MAX_LOG_TITLE_LENGTH = 200;
/** Maximum length of a log description. */
export const MAX_LOG_DESCRIPTION_LENGTH = 2000;
/** Maximum length of a log icon (one or two emoji). */
export const MAX_LOG_ICON_LENGTH = 16;
/** Maximum number of props on one log. */
export const MAX_LOG_PROPS = 40;
/** Maximum length of a prop key. */
export const MAX_LOG_PROP_KEY_LENGTH = 64;
/** Maximum length of a string prop value. */
export const MAX_LOG_PROP_VALUE_LENGTH = 500;
/** Logs older than this are queued for deletion. */
export const LOG_RETENTION_DAYS = 30;
export const DEFAULT_LOG_QUERY_LIMIT = 100;
export const MAX_LOG_QUERY_LIMIT = 500;

/** Lowercase dotted or dashed event names: `signup`, `waitlist.join`, `payment:failed`. */
export const LOG_EVENT_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;

const uuidV4 = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, 'uuid v4');

const optionalText = (max: number) => z.string().trim().min(1).max(max).optional();

export const LogLevelField = z.enum(LOG_LEVELS);

export const LogPropValue = z.union([
  z.string().max(MAX_LOG_PROP_VALUE_LENGTH),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export type LogPropValue = z.infer<typeof LogPropValue>;

export const LogProps = z
  .record(z.string().min(1).max(MAX_LOG_PROP_KEY_LENGTH), LogPropValue)
  .refine((props) => Object.keys(props).length <= MAX_LOG_PROPS, {
    message: `at most ${MAX_LOG_PROPS} props`,
  });
export type LogProps = z.infer<typeof LogProps>;

/** One owner-authored application log. */
export const LogEventV1 = z
  .object({
    log_id: uuidV4,
    timestamp: z.number().int().min(0),
    event: z.string().regex(LOG_EVENT_PATTERN, 'lowercase event name'),
    level: LogLevelField.default('info'),
    title: optionalText(MAX_LOG_TITLE_LENGTH),
    description: optionalText(MAX_LOG_DESCRIPTION_LENGTH),
    icon: optionalText(MAX_LOG_ICON_LENGTH),
    props: LogProps.default({}),
  })
  .strict();
export type LogEventV1 = z.infer<typeof LogEventV1>;

/** V1 log batch sent by an SDK or drop-in client. */
export const LogBatchV1 = z
  .object({
    batch_id: uuidV4.optional(),
    schema_version: z.literal(SCHEMA_VERSION),
    environment: EnvironmentName.optional(),
    logs: z.array(LogEventV1).min(1).max(MAX_LOG_BATCH),
  })
  .strict();
export type LogBatchV1 = z.infer<typeof LogBatchV1>;

/** A log as stored and returned: the ingest event plus its source. */
export const StoredLogV1 = LogEventV1.extend({ source: LogSourceField });
export type StoredLogV1 = z.infer<typeof StoredLogV1>;

/** Browser batch: the public key travels in the body so the request needs no custom header (no CORS preflight, sendBeacon-friendly). */
export const BrowserLogBatchV1 = LogBatchV1.extend({
  public_key: z.string().startsWith(PUBLIC_LOG_KEY_PREFIX),
}).strict();
export type BrowserLogBatchV1 = z.infer<typeof BrowserLogBatchV1>;

export type Validation<T> = { ok: true; batch: T } | { ok: false; errors: string[] };

function validateWith<T>(schema: z.ZodTypeAny, input: unknown): Validation<T> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, batch: parsed.data as T };
  return {
    ok: false,
    errors: parsed.error.issues.map((issue) => `${issue.path.join('.') || '$'}: ${issue.message}`),
  };
}

export function validateLogBatch(input: unknown): Validation<LogBatchV1> {
  return validateWith(LogBatchV1, input);
}

export function validateBrowserLogBatch(input: unknown): Validation<BrowserLogBatchV1> {
  return validateWith(BrowserLogBatchV1, input);
}

/** `https://app.example.com` — scheme and host only, no path. */
export const WebOrigin = z
  .string()
  .regex(/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i, 'origin (scheme://host[:port])');

export const PublicLogKeyV1 = z.object({
  id: z.string().min(1),
  app_id: z.string().min(1),
  environment_id: z.string().min(1),
  allowed_origins: z.array(WebOrigin).min(1).max(MAX_ALLOWED_ORIGINS),
  created_at: z.number().int().min(0),
  revoked_at: z.number().int().min(0).nullable(),
});
export type PublicLogKeyV1 = z.infer<typeof PublicLogKeyV1>;

export const CreatePublicLogKeyRequestV1 = z
  .object({
    app_id: z.string().min(1),
    environment_id: z.string().min(1),
    allowed_origins: z.array(WebOrigin).min(1).max(MAX_ALLOWED_ORIGINS),
  })
  .strict();
export type CreatePublicLogKeyRequestV1 = z.infer<typeof CreatePublicLogKeyRequestV1>;

/** The raw public key is returned exactly once, here. */
export const CreatePublicLogKeyResponseV1 = z.object({
  key: z.string().startsWith(PUBLIC_LOG_KEY_PREFIX),
  record: PublicLogKeyV1,
});
export type CreatePublicLogKeyResponseV1 = z.infer<typeof CreatePublicLogKeyResponseV1>;

export const ListPublicLogKeysResponseV1 = z.object({ keys: z.array(PublicLogKeyV1) });
export type ListPublicLogKeysResponseV1 = z.infer<typeof ListPublicLogKeysResponseV1>;

// ---------------------------------------------------------------------------
// Routing: which sinks receive a log. Rules are evaluated per log; a log goes
// to the union of sinks from every matching rule. `store` is the D1 table the
// dashboard reads; `slack` is the incoming webhook. New sinks are added here.

export const LOG_SINKS = ['store', 'slack'] as const;
export type LogSink = (typeof LOG_SINKS)[number];
export const LogSinkField = z.enum(LOG_SINKS);

export const LogRouteV1 = z
  .object({
    match: z
      .object({
        source: LogSourceField.optional(),
        min_level: LogLevelField.optional(),
        event: z.string().regex(LOG_EVENT_PATTERN).optional(),
      })
      .strict()
      .default({}),
    sinks: z.array(LogSinkField).min(1),
  })
  .strict();
export type LogRouteV1 = z.infer<typeof LogRouteV1>;

export const LogRoutesV1 = z.array(LogRouteV1).min(1);
export type LogRoutesV1 = z.infer<typeof LogRoutesV1>;

/** Store everything; alert on server logs at `serverAlertLevel` and browser logs at error. */
export function defaultLogRoutes(serverAlertLevel: LogLevel = 'info'): LogRoutesV1 {
  return [
    { match: {}, sinks: ['store'] },
    { match: { source: 'server', min_level: serverAlertLevel }, sinks: ['slack'] },
    { match: { source: 'browser', min_level: 'error' }, sinks: ['slack'] },
  ];
}

export function logMatchesRoute(log: StoredLogV1, route: LogRouteV1): boolean {
  const { source, min_level, event } = route.match;
  if (source !== undefined && log.source !== source) return false;
  if (min_level !== undefined && !logLevelAtLeast(log.level, min_level)) return false;
  return event === undefined || log.event === event;
}

/** Group logs by destination sink according to the routes. Sinks with no logs are absent. */
export function routeLogs(
  logs: readonly StoredLogV1[],
  routes: LogRoutesV1,
): Partial<Record<LogSink, StoredLogV1[]>> {
  const grouped: Partial<Record<LogSink, StoredLogV1[]>> = {};
  for (const log of logs) {
    const sinks = new Set<LogSink>();
    for (const route of routes) {
      if (logMatchesRoute(log, route)) for (const sink of route.sinks) sinks.add(sink);
    }
    for (const sink of sinks) (grouped[sink] ??= []).push(log);
  }
  return grouped;
}

/** True when `level` is at or above `minimum` in severity. */
export function logLevelAtLeast(level: LogLevel, minimum: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(minimum);
}

export const LogQueryRequestV1 = z
  .object({
    app_id: z.string().min(1),
    environment_id: z.string().min(1),
    /** Minimum level, inclusive. */
    level: LogLevelField.default('debug'),
    source: LogSourceField.optional(),
    event: z.string().regex(LOG_EVENT_PATTERN).optional(),
    limit: z.number().int().min(1).max(MAX_LOG_QUERY_LIMIT).default(DEFAULT_LOG_QUERY_LIMIT),
  })
  .strict();
export type LogQueryRequestV1 = z.infer<typeof LogQueryRequestV1>;

export const LogQueryResponseV1 = z.object({
  refreshed_at: z.number().int().min(0),
  level: LogLevelField,
  retention_days: z.literal(LOG_RETENTION_DAYS),
  limit: z.number().int().min(1).max(MAX_LOG_QUERY_LIMIT),
  logs: z.array(StoredLogV1),
});
export type LogQueryResponseV1 = z.infer<typeof LogQueryResponseV1>;
