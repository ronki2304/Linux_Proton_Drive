import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { formatSuccess, formatError, makeProgressCallback } from "./output.js";
import { ProtonDriveError, ConfigError } from "../errors.js";

describe("formatSuccess", () => {
  let stdoutWrites: string[];
  let originalWrite: typeof process.stdout.write;

  beforeEach(() => {
    stdoutWrites = [];
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array) => {
      stdoutWrites.push(String(chunk));
      return true;
    };
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  test("JSON mode writes { ok: true, data } to stdout", () => {
    formatSuccess({ id: "abc", name: "test" }, { json: true });
    expect(stdoutWrites).toHaveLength(1);
    const parsed = JSON.parse(stdoutWrites[0]!);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual({ id: "abc", name: "test" });
  });

  test("JSON mode includes ok:true even for empty data", () => {
    formatSuccess({}, { json: true });
    const parsed = JSON.parse(stdoutWrites[0]!);
    expect(parsed.ok).toBe(true);
  });

  test("human mode writes plain string to stdout", () => {
    formatSuccess("Upload complete", { json: false });
    expect(stdoutWrites[0]).toBe("Upload complete\n");
  });

  test("human mode with no json option defaults to human", () => {
    formatSuccess("Done", {});
    expect(stdoutWrites[0]).toBe("Done\n");
  });
});

describe("formatError", () => {
  let stderrWrites: string[];
  let originalWrite: typeof process.stderr.write;

  beforeEach(() => {
    stderrWrites = [];
    originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array) => {
      stderrWrites.push(String(chunk));
      return true;
    };
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
  });

  test("JSON mode writes { ok: false, error: { code, message } } to stderr", () => {
    const err = new ConfigError("config file missing");
    formatError(err, { json: true });
    expect(stderrWrites).toHaveLength(1);
    const parsed = JSON.parse(stderrWrites[0]!);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("CONFIG_ERROR");
    expect(parsed.error.message).toBe("config file missing");
  });

  test("JSON mode uses UNKNOWN code for plain Error", () => {
    formatError(new Error("boom"), { json: true });
    const parsed = JSON.parse(stderrWrites[0]!);
    expect(parsed.error.code).toBe("UNKNOWN");
    expect(parsed.error.message).toBe("boom");
  });

  test("human mode writes 'error: CODE — message' to stderr", () => {
    const err = new ProtonDriveError("AUTH_FAILED", "invalid credentials");
    formatError(err, { json: false });
    expect(stderrWrites[0]).toBe("error: AUTH_FAILED — invalid credentials\n");
  });

  test("human mode with plain Error uses UNKNOWN code", () => {
    formatError(new Error("unexpected"), { json: false });
    expect(stderrWrites[0]).toBe("error: UNKNOWN — unexpected\n");
  });
});

describe("makeProgressCallback", () => {
  let stdoutWrites: string[];
  let originalWrite: typeof process.stdout.write;

  beforeEach(() => {
    stdoutWrites = [];
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array) => {
      stdoutWrites.push(String(chunk));
      return true;
    };
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  test("human mode returns callback that writes [prefix] msg", () => {
    const cb = makeProgressCallback("sync", { json: false });
    cb("Uploading Documents/notes.md...");
    expect(stdoutWrites[0]).toBe("[sync] Uploading Documents/notes.md...\n");
  });

  test("JSON mode returns no-op — nothing written to stdout", () => {
    const cb = makeProgressCallback("sync", { json: true });
    cb("this should not appear");
    expect(stdoutWrites).toHaveLength(0);
  });

  test("human mode callback can be called multiple times", () => {
    const cb = makeProgressCallback("upload", { json: false });
    cb("step 1");
    cb("step 2");
    expect(stdoutWrites).toHaveLength(2);
    expect(stdoutWrites[0]).toBe("[upload] step 1\n");
    expect(stdoutWrites[1]).toBe("[upload] step 2\n");
  });
});
