import type { ArchiveReplacementProof } from '@app-health/contracts';

/**
 * No source object is currently authorized for deletion. Counts and metadata
 * are not sufficient to prove cryptographic/content equivalence; keep this
 * fail-closed until a compactor can verify the actual source and replacement.
 */
export function supersededArchiveSources(proofs: readonly ArchiveReplacementProof[]): string[] {
  void proofs;
  return [];
}
