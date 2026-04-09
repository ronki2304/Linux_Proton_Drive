import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
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
    assert.equal(fs.existsSync(logPath), false);
  });

  it("does nothing when PROTONDRIVE_DEBUG is set to a non-1 value", () => {
    process.env["PROTONDRIVE_DEBUG"] = "true"; // not "1"
    debugLog("should not appear");
    assert.equal(fs.existsSync(logPath), false);
  });

  it("appends to the log file when PROTONDRIVE_DEBUG=1", () => {
    process.env["PROTONDRIVE_DEBUG"] = "1";
    debugLog("test message one");
    debugLog("test message two");

    assert.equal(fs.existsSync(logPath), true);
    const contents = fs.readFileSync(logPath, "utf8");
    assert.match(contents, /test message one/);
    assert.match(contents, /test message two/);
    // Two distinct lines.
    assert.equal(contents.trim().split("\n").length, 2);
  });

  it("preserves the cause chain for Error arguments", () => {
    process.env["PROTONDRIVE_DEBUG"] = "1";
    const inner = new Error("inner failure");
    const outer = new Error("outer failure", { cause: inner });
    debugLog("wrapped error", outer);

    const contents = fs.readFileSync(logPath, "utf8");
    assert.match(contents, /wrapped error/);
    assert.match(contents, /outer failure/);
    assert.match(contents, /inner failure/);
  });

  it("rotates the log file when it exceeds the size cap", () => {
    process.env["PROTONDRIVE_DEBUG"] = "1";
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    // Pre-fill the log to just over the cap so the next write triggers rotation.
    const big = Buffer.alloc(5 * 1024 * 1024 + 100, "x");
    fs.writeFileSync(logPath, big);

    debugLog("post-rotation message");

    const rotated = `${logPath}.1`;
    assert.equal(fs.existsSync(rotated), true, "rotated file should exist");
    const newContents = fs.readFileSync(logPath, "utf8");
    assert.match(newContents, /post-rotation message/);
    // The new file should NOT contain the old content.
    assert.equal(newContents.includes("x".repeat(100)), false);
  });

  it("swallows filesystem errors silently", () => {
    process.env["PROTONDRIVE_DEBUG"] = "1";
    // Point cache home at a path that cannot be created (parent is a file).
    const blocker = path.join(tmpDir, "blocker");
    fs.writeFileSync(blocker, "");
    process.env["XDG_CACHE_HOME"] = path.join(blocker, "nope");
    // Should not throw despite mkdir failing.
    assert.doesNotThrow(() => debugLog("ignored"));
  });
});
