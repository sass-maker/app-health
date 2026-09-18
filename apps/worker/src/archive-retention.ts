import { ArchiveReplacementProofV1, type ArchiveReplacementProof } from '@app-health/contracts';

/**
 * Physical source objects may be superseded only by a verified, logically equivalent object.
 * Age alone is never evidence that an analytics fact is safe to remove.
 */
export function supersededArchiveSources(proofs: readonly ArchiveReplacementProof[]): string[] {
  return proofs.flatMap((candidate) => {
    const parsed = ArchiveReplacementProofV1.safeParse(candidate);
    if (!parsed.success) return [];
    const proof = parsed.data;
    if (
      proof.state !== 'verified' ||
      proof.source_key === proof.replacement_key ||
      proof.source_rows !== proof.replacement_rows ||
      proof.source_events !== proof.replacement_events
    )
      return [];
    return [proof.source_key];
  });
}
