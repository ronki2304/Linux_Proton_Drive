import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  detectConflict,
  buildConflictCopyName,
  createConflictCopy,
} from "./conflict.js";

const LAST_SYNC = "2026-03-31T10:00:00.000Z";
const BEFORE_SYNC = "2026-03-31T09:00:00.000Z";
const AFTER_SYNC_A = "2026-04-01T11:00:00.000Z";
const AFTER_SYNC_B = "2026-04-01T12:00:00.000Z";

describe("detectConflict", () => {
  test("both sides changed after lastSyncMtime → true", () => {
    expect(detectConflict(AFTER_SYNC_A, AFTER_SYNC_B, LAST_SYNC)).toBe(true);
  });

  test("only local changed → false", () => {
    expect(detectConflict(AFTER_SYNC_A, BEFORE_SYNC, LAST_SYNC)).toBe(false);
  });

  test("only remote changed → false", () => {
    expect(detectConflict(BEFORE_SYNC, AFTER_SYNC_A, LAST_SYNC)).toBe(false);
  });

  test("neither side changed → false", () => {
    expect(detectConflict(BEFORE_SYNC, BEFORE_SYNC, LAST_SYNC)).toBe(false);
  });

  test("equal to lastSyncMtime is not a change → false", () => {
    expect(detectConflict(LAST_SYNC, AFTER_SYNC_A, LAST_SYNC)).toBe(false);
  });

  test("both sides equal to lastSyncMtime → false", () => {
    expect(detectConflict(LAST_SYNC, LAST_SYNC, LAST_SYNC)).toBe(false);
  });
});

describe("buildConflictCopyName", () => {
  const date = new Date(2026, 3, 1); // April 1, 2026 (local time)

  test("file with extension → filename.conflict-YYYY-MM-DD", () => {
    expect(buildConflictCopyName("notes.md", date)).toBe(
      "notes.md.conflict-2026-04-01",
    );
  });

  test("file without extension → filename.conflict-YYYY-MM-DD", () => {
    expect(buildConflictCopyName("Makefile", date)).toBe(
      "Makefile.conflict-2026-04-01",
    );
  });

  test("file already has .conflict- suffix → still appends correctly", () => {
    const result = buildConflictCopyName(
      "notes.md.conflict-2026-03-31",
      date,
    );
    expect(result).toBe("notes.md.conflict-2026-03-31.conflict-2026-04-01");
  });

  test("file with multiple extensions", () => {
    expect(buildConflictCopyName("archive.tar.gz", date)).toBe(
      "archive.tar.gz.conflict-2026-04-01",
    );
  });

  test("month and day are zero-padded", () => {
    const jan1 = new Date(2026, 0, 5); // Jan 5
    expect(buildConflictCopyName("file.txt", jan1)).toBe(
      "file.txt.conflict-2026-01-05",
    );
  });
});

describe("createConflictCopy", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conflict-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates a copy with conflict name", () => {
    const originalPath = path.join(tmpDir, "notes.md");
    fs.writeFileSync(originalPath, "original content");
    const date = new Date(2026, 3, 1);
    const result = createConflictCopy(originalPath, date);
    expect(result.conflictCopy).toBe(
      path.join(tmpDir, "notes.md.conflict-2026-04-01"),
    );
    expect(fs.existsSync(result.conflictCopy)).toBe(true);
    expect(fs.readFileSync(result.conflictCopy, "utf8")).toBe("original content");
  });

  test("original file is not modified", () => {
    const originalPath = path.join(tmpDir, "file.txt");
    fs.writeFileSync(originalPath, "do not change me");
    const date = new Date(2026, 3, 1);
    createConflictCopy(originalPath, date);
    expect(fs.readFileSync(originalPath, "utf8")).toBe("do not change me");
  });

  test("original still exists after conflict copy", () => {
    const originalPath = path.join(tmpDir, "important.doc");
    fs.writeFileSync(originalPath, "data");
    createConflictCopy(originalPath, new Date());
    expect(fs.existsSync(originalPath)).toBe(true);
  });

  test("returns ConflictRecord with correct paths", () => {
    const originalPath = path.join(tmpDir, "test.txt");
    fs.writeFileSync(originalPath, "x");
    const date = new Date(2026, 3, 1);
    const record = createConflictCopy(originalPath, date);
    expect(record.original).toBe(originalPath);
    expect(record.conflictCopy).toContain("conflict-");
  });
});
