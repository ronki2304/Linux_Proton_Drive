// Pure conflict detection module — zero internal engine imports.
// All async work (hash computation) lives in sync-engine.ts.

export type ConflictReason =
  | "both_changed"               // Clear mtime divergence
  | "same_second_hash_mismatch"  // Same-second ambiguity resolved by hash
  | "hash_unavailable";          // Same-second but no stored or computable hash — conservative

export interface ConflictResult {
  isConflict: boolean;
  reason?: ConflictReason;
}

/** Returns true when two ISO 8601 strings are identical at second precision (differ only at ms). */
function sameSecond(a: string, b: string): boolean {
  return a.slice(0, 19) === b.slice(0, 19);
}

/**
 * Determine whether concurrent changes to local and remote constitute a conflict.
 *
 * @param localMtime        Current local mtime
 * @param storedLocalMtime  Mtime stored in sync_state from last sync
 * @param remoteMtime       Current remote mtime
 * @param storedRemoteMtime Mtime stored in sync_state from last sync
 * @param storedHash        SHA-256 hash stored in sync_state (null if unavailable)
 * @param currentLocalHash  SHA-256 hash of current local file (null if unreadable or not computed)
 */
export function detectConflict(
  localMtime: string,
  storedLocalMtime: string,
  remoteMtime: string,
  storedRemoteMtime: string,
  storedHash: string | null,
  currentLocalHash: string | null,
): ConflictResult {
  const localChanged  = localMtime  !== storedLocalMtime;
  const remoteChanged = remoteMtime !== storedRemoteMtime;

  // Only one (or neither) side changed → no conflict
  if (!localChanged || !remoteChanged) {
    return { isConflict: false };
  }

  // Both changed. Check for same-second ambiguity on both sides.
  const localSameSecond  = sameSecond(localMtime,  storedLocalMtime);
  const remoteSameSecond = sameSecond(remoteMtime, storedRemoteMtime);

  if (!localSameSecond || !remoteSameSecond) {
    // Clear mtime divergence — definite conflict
    return { isConflict: true, reason: "both_changed" };
  }

  // Same-second on both sides — use hash to disambiguate
  if (storedHash === null || currentLocalHash === null) {
    // No hash available — conservative: flag as conflict
    return { isConflict: true, reason: "hash_unavailable" };
  }

  if (currentLocalHash === storedHash) {
    // Content unchanged despite mtime difference (e.g. touch) — not a conflict
    return { isConflict: false };
  }

  return { isConflict: true, reason: "same_second_hash_mismatch" };
}
