import { buildLogAlert, type LogAlertContext } from './log-alert-format.js';
export { buildLogAlert, escapeMrkdwn, type LogAlertContext } from './log-alert-format.js';
// Optional Slack delivery for application logs. Configured per deployment with
// LOG_ALERT_WEBHOOK_URL (secret) and LOG_ALERT_MIN_LEVEL (var). Delivery runs
// after the ingest response so a slow webhook never slows the sending app.

import { logLevelAtLeast, type LogEventV1, type LogLevel } from '@app-health/contracts';

export interface LogAlertOptions extends LogAlertContext {
  webhookUrl: string;
  minLevel: LogLevel;
  fetch?: typeof fetch;
}

/** Post every log at or above the threshold. Returns the number delivered; never throws. */
export async function deliverLogAlerts(
  logs: readonly LogEventV1[],
  options: LogAlertOptions,
): Promise<number> {
  const deadline = Date.now() + 10_000;
  let delivered = 0;
  for (const log of logs) {
    if (!logLevelAtLeast(log.level, options.minLevel)) continue;
    if (Date.now() >= deadline) break;
    if (await postLogAlert(log, options, Math.max(1, Math.min(2000, deadline - Date.now()))))
      delivered += 1;
  }
  return delivered;
}

async function postLogAlert(
  log: LogEventV1,
  options: LogAlertOptions,
  timeoutMs: number,
): Promise<boolean> {
  const fetchFn = options.fetch ?? fetch;
  try {
    const response = await fetchFn(options.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildLogAlert(log, options)),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) return true;
    else console.error(JSON.stringify({ msg: 'log alert rejected', status: response.status }));
  } catch {
    console.error(JSON.stringify({ msg: 'log alert failed' }));
  }
  return false;
}
