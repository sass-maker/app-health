const ARCHIVE_RETENTION_DAYS = 30;
const PAGE_SIZE = 1000;
const MAX_PAGES = 4;

interface ArchiveBucket {
  list(options: {
    prefix: string;
    limit: number;
  }): Promise<{ objects: { key: string }[]; truncated: boolean }>;
  delete(keys: string[]): Promise<void>;
}

/** Calendar-partitioned archives expire automatically; each invocation has a fixed work bound. */
export async function expireBrowserArchives(bucket: ArchiveBucket, now = Date.now()) {
  const cutoff = `browser-v2/${new Date(now - ARCHIVE_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10).replaceAll('-', '/')}/`;
  let deleted = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await bucket.list({ prefix: 'browser-v2/', limit: PAGE_SIZE });
    const expired = result.objects
      .filter(({ key }) => /^browser-v2\/\d{4}\/\d{2}\/\d{2}\//.test(key) && key < cutoff)
      .map(({ key }) => key);
    if (!expired.length) return { deleted, backlog: false };
    await bucket.delete(expired);
    deleted += expired.length;
    if (!result.truncated || expired.length < result.objects.length)
      return { deleted, backlog: false };
  }
  return { deleted, backlog: true };
}
