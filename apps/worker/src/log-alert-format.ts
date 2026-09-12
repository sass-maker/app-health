import type { LogEventV1, LogLevel } from '@app-health/contracts';

export interface LogAlertContext {
  appName: string;
  environmentName: string;
}

const DEFAULT_ICONS: Record<LogLevel, string> = {
  debug: '🔍',
  info: '🔔',
  warn: '⚠️',
  error: '🚨',
};

export function escapeMrkdwn(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function formatProp(value: LogEventV1['props'][string]): string {
  if (value === null) return '_null_';
  return typeof value === 'string' ? escapeMrkdwn(value) : String(value);
}

/** Slack Block Kit payload for one log. */
export function buildLogAlert(log: LogEventV1, context: LogAlertContext): Record<string, unknown> {
  const icon = log.icon ?? DEFAULT_ICONS[log.level];
  const tag = log.level === 'info' ? '' : ` \`${log.level.toUpperCase()}\``;
  const scope = `*${escapeMrkdwn(context.appName)}* / ${escapeMrkdwn(context.environmentName)}`;
  const headline = `${icon} ${scope} · \`${escapeMrkdwn(log.event)}\`${tag}`;
  const blocks: Record<string, unknown>[] = [
    { type: 'section', text: { type: 'mrkdwn', text: headline } },
  ];
  const lines = [
    ...(log.title ? [`*${escapeMrkdwn(log.title)}*`] : []),
    ...(log.description ? [escapeMrkdwn(log.description)] : []),
  ];
  if (lines.length > 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } });
  }
  const props = Object.entries(log.props);
  if (props.length > 0) {
    // Slack allows at most 10 fields per section; the remainder becomes one text block.
    blocks.push({
      type: 'section',
      fields: props.slice(0, 10).map(([key, value]) => ({
        type: 'mrkdwn',
        text: `*${escapeMrkdwn(key)}*\n${formatProp(value)}`,
      })),
    });
    if (props.length > 10) {
      const rest = props
        .slice(10)
        .map(([key, value]) => `• *${escapeMrkdwn(key)}*: ${formatProp(value)}`)
        .join('\n');
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: rest } });
    }
  }
  blocks.push({
    type: 'context',
    elements: [
      { type: 'mrkdwn', text: `${new Date(log.timestamp).toISOString()} · ${log.log_id}` },
    ],
  });
  const fallback = `[${context.appName}/${context.environmentName}] ${log.event}${log.title ? `: ${log.title}` : ''}`;
  return { text: fallback, blocks };
}
