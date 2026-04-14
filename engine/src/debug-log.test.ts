import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { debugLog } from "./debug-log.js";

function freshTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "debug-log-test-"));
}

function rmRf(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}

describe("debugLog", () => {
  let tmpDir: string;
  let logPath: string;
  const originalDebug = process.env["PROTONDRIVE_DEBUG"];
  const originalCacheHome = process.env["XDG_CACHE_HOME"];

  beforeEach(() => {
    tmpDir = freshTmpDir();
    process.env["XDG_CACHE_HOME"] = tmpDir;
    logPath = path.join(tmpDir, "protondrive", "engine.log");
  });

  afterEach(() => {
    if (originalDebug === undefined) {
      delete process.env["PROTONDRIVE_DEBUG"];
    } else {
      process.env["PROTONDRIVE_DEBUG"] = originalDebug;
    }
    if (originalCacheHome === undefined) {
      delete process.env["XDG_CACHE_HOME"];
    } else {
      process.env["XDG_CACHE_HOME"] = originalCacheHome;
    }
    rmRf(tmpDir);
  });

  it("does nothing when PROTONDRIVE_DEBUG is unset", () => {
    delete process.env["PROTONDRIVE_DEBUG"];
    debugLog("should not appear");
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it("does nothing when PROTONDRIVE_DEBUG is set to a non-1 value", () => {
    process.env["PROTONDRIVE_DEBUG"] = "true"; // not "1"
    debugLog("should not appear");
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it("appends to the log file when PROTONDRIVE_DEBUG=1", () => {
    process.env["PROTONDRIVE_DEBUG"] = "1";
    debugLog("test message one");
    debugLog("test message two");

    expect(fs.existsSync(logPath)).toBe(true);
    const contents = fs.readFileSync(logPath, "utf8");
    expect(contents).toMatch(/test message one/);
    expect(contents).toMatch(/test message two/);
    // Two distinct lines.
    expect(contents.trim().split("\n").length).toBe(2);
  });

  it("preserves the cause chain for Error arguments", () => {
    process.env["PROTONDRIVE_DEBUG"] = "1";
    const inner = new Error("inner failure");
    const outer = new Error("outer failure", { cause: inner });
    debugLog("wrapped error", outer);

    const contents = fs.readFileSync(logPath, "utf8");
    expect(contents).toMatch(/wrapped error/);
    expect(contents).toMatch(/outer failure/);
    expect(contents).toMatch(/inner failure/);
  });

  it("rotates the log file when it exceeds the size cap", () => {
    process.env["PROTONDRIVE_DEBUG"] = "1";
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    // Pre-fill the log to just over the cap so the next write triggers rotation.
    const big = Buffer.alloc(5 * 1024 * 1024 + 100, "x");
    fs.writeFileSync(logPath, big);

    debugLog("post-rotation message");

    const rotated = `${logPath}.1`;
    expect(fs.existsSync(rotated)).toBe(true);
    const newContents = fs.readFileSync(logPath, "utf8");
    expect(newContents).toMatch(/post-rotation message/);
    // The new file should NOT contain the old content.
    expect(newContents.includes("x".repeat(100))).toBe(false);
  });

  it("swallows filesystem errors silently", () => {
    process.env["PROTONDRIVE_DEBUG"] = "1";
    // Point cache home at a path that cannot be created (parent is a file).
    const blocker = path.join(tmpDir, "blocker");
    fs.writeFileSync(blocker, "");
    process.env["XDG_CACHE_HOME"] = path.join(blocker, "nope");
    // Should not throw despite mkdir failing.
    expect(() => debugLog("ignored")).not.toThrow();
  });
});
