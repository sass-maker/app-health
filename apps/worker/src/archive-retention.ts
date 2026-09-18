/**
 * No canonical successor/manifest is available yet. Age alone is not evidence
 * that an archive is safe to delete. Keep the scheduled hook non-destructive
 * until verified compaction can authorize individual source objects (#62).
 * The independent R2 provider lifecycle must also be removed before release.
 */
export async function expireBrowserArchives(_bucket: unknown, _now = Date.now()) {
  return { deleted: 0, backlog: false };
}
