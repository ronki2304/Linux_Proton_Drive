import * as fs from "fs";
import * as path from "path";
import type { ConflictRecord } from "../types.js";

export function detectConflict(
  localMtime: string,
  remoteMtime: string,
  lastSyncMtime: string,
): boolean {
  return localMtime > lastSyncMtime && remoteMtime > lastSyncMtime;
}

export function buildConflictCopyName(filename: string, date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${filename}.conflict-${yyyy}-${mm}-${dd}`;
}

export function createConflictCopy(
  originalPath: string,
  date: Date = new Date(),
): ConflictRecord {
  const dir = path.dirname(originalPath);
  const filename = path.basename(originalPath);
  const conflictName = buildConflictCopyName(filename, date);
  const conflictCopyPath = path.join(dir, conflictName);
  fs.copyFileSync(originalPath, conflictCopyPath);
  return { original: originalPath, conflictCopy: conflictCopyPath };
}
