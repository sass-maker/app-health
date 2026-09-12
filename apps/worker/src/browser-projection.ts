import type { CollectedBrowserBatch, BrowserBindings } from './browser-analytics.js';

export function projectBrowserBatch(batch: CollectedBrowserBatch, env: BrowserBindings): void {
  if (!env.BROWSER_ANALYTICS) throw new Error('browser analytical projection missing');
  const attribution = batch.attribution ?? {
    source: '',
    medium: '',
    campaign: '',
    entry_path: '',
    content: '',
    term: '',
  };
  const metadata = batch.metadata ?? { channel: '', device: '', browser: '', country: '' };
  for (const event of batch.events)
    env.BROWSER_ANALYTICS.writeDataPoint({
      indexes: [batch.workspace],
      blobs: [
        batch.app_id,
        batch.environment_id,
        event.type,
        event.path,
        event.name ?? '',
        event.referrer,
        batch.session_hash || '',
        batch.visitor_hash || '',
        batch.visit_type || '',
        attribution.source || event.referrer,
        attribution.medium,
        attribution.campaign,
        metadata.channel,
        metadata.device,
        metadata.browser,
        metadata.country,
        attribution.entry_path,
        attribution.content,
        attribution.term,
      ],
      doubles: [1, event.timestamp],
    });
}
