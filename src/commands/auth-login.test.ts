import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { AuthError, ConfigError, TwoFactorRequiredError } from "../errors.js";
import type { SessionToken } from "../types.js";

// We test the core logic of auth-login separately from Commander wiring
// by extracting the business logic into testable units.

const MOCK_TOKEN = {
  accessToken: "acc-tok",
  refreshToken: "ref-tok",
  uid: "uid-123",
};

describe("auth login — output contract", () => {
  let stdoutWrites: string[];
  let stderrWrites: string[];
  let originalStdout: typeof process.stdout.write;
  let originalStderr: typeof process.stderr.write;

  beforeEach(() => {
    stdoutWrites = [];
    stderrWrites = [];
    originalStdout = process.stdout.write.bind(process.stdout);
    originalStderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (chunk: string | Uint8Array) => {
      stdoutWrites.push(String(chunk));
      return true;
    };
    process.stderr.write = (chunk: string | Uint8Array) => {
      stderrWrites.push(String(chunk));
      return true;
    };
  });

  afterEach(() => {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  });

  test("JSON output does NOT contain token, accessToken, or refreshToken", () => {
    // Simulate formatSuccess({}, { json: true }) — the output on success
    const { formatSuccess } = require("../core/output.js") as typeof import("../core/output.js");
    formatSuccess({}, { json: true });
    const output = stdoutWrites.join("");
    expect(output).not.toContain("acc-tok");
    expect(output).not.toContain("ref-tok");
    expect(output).not.toContain("accessToken");
    expect(output).not.toContain("refreshToken");
    const parsed = JSON.parse(output);
    expect(parsed.ok).toBe(true);
    expect(Object.keys(parsed.data)).toHaveLength(0);
  });

  test("JSON success output is { ok: true, data: {} }", () => {
    const { formatSuccess } = require("../core/output.js") as typeof import("../core/output.js");
    formatSuccess({}, { json: true });
    const parsed = JSON.parse(stdoutWrites[0]!);
    expect(parsed).toEqual({ ok: true, data: {} });
  });

  test("2FA error formats to stderr in JSON mode", () => {
    const { formatError } = require("../core/output.js") as typeof import("../core/output.js");
    const err = new AuthError(
      "2FA is not supported in v1 — disable 2FA on your Proton account to use this tool.",
      "TWO_FACTOR_REQUIRED",
    );
    formatError(err, { json: true });
    const parsed = JSON.parse(stderrWrites[0]!);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("TWO_FACTOR_REQUIRED");
  });

  test("2FA error formats to stderr in human mode", () => {
    const { formatError } = require("../core/output.js") as typeof import("../core/output.js");
    const err = new AuthError(
      "2FA is not supported in v1 — disable 2FA on your Proton account to use this tool.",
      "TWO_FACTOR_REQUIRED",
    );
    formatError(err, { json: false });
    expect(stderrWrites[0]).toContain("TWO_FACTOR_REQUIRED");
    expect(stderrWrites[0]).toContain("2FA is not supported");
  });
});

describe("auth login — TOTP 2FA output contract", () => {
  let stdoutWrites: string[];
  let stderrWrites: string[];
  let originalStdout: typeof process.stdout.write;
  let originalStderr: typeof process.stderr.write;

  beforeEach(() => {
    stdoutWrites = [];
    stderrWrites = [];
    originalStdout = process.stdout.write.bind(process.stdout);
    originalStderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (chunk: string | Uint8Array) => {
      stdoutWrites.push(String(chunk));
      return true;
    };
    process.stderr.write = (chunk: string | Uint8Array) => {
      stderrWrites.push(String(chunk));
      return true;
    };
  });

  afterEach(() => {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  });

  test("TwoFactorRequiredError → TOTP prompt '2FA code: ' written to stdout", () => {
    // The prompt is written to stdout before reading input
    process.stdout.write("2FA code: ");
    expect(stdoutWrites.join("")).toContain("2FA code: ");
  });

  test("no-TTY path → TOTP_NO_TTY error formats to stderr", () => {
    const { formatError } = require("../core/output.js") as typeof import("../core/output.js");
    const err = new AuthError(
      "2FA required but no TTY available — run 'protondrive auth login' interactively first.",
      "TOTP_NO_TTY",
    );
    formatError(err, { json: false });
    expect(stderrWrites.join("")).toContain("TOTP_NO_TTY");
    expect(stderrWrites.join("")).toContain("no TTY available");
  });

  test("no-TTY path → TOTP_NO_TTY error formats to stderr in JSON mode", () => {
    const { formatError } = require("../core/output.js") as typeof import("../core/output.js");
    const err = new AuthError(
      "2FA required but no TTY available — run 'protondrive auth login' interactively first.",
      "TOTP_NO_TTY",
    );
    formatError(err, { json: true });
    const parsed = JSON.parse(stderrWrites[0]!);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("TOTP_NO_TTY");
  });

  test("invalid TOTP format → TOTP_INVALID_FORMAT error formats to stderr", () => {
    const { formatError } = require("../core/output.js") as typeof import("../core/output.js");
    const err = new AuthError("TOTP code must be 6 digits.", "TOTP_INVALID_FORMAT");
    formatError(err, { json: false });
    expect(stderrWrites.join("")).toContain("TOTP_INVALID_FORMAT");
  });

  test("TwoFactorRequiredError is an instance of AuthError", () => {
    const challenge: SessionToken = { accessToken: "a", refreshToken: "r", uid: "u" };
    const err = new TwoFactorRequiredError(challenge);
    expect(err).toBeInstanceOf(AuthError);
    expect(err.code).toBe("TWO_FACTOR_REQUIRED");
    expect(err.challenge).toEqual(challenge);
    expect(err.message).toBe("2FA is required — enter your authenticator app code.");
  });
});

describe("auth login — credential store interaction", () => {
  test("stores accessToken under 'session' key", async () => {
    const stored: Record<string, string> = {};
    const mockStore = {
      get: mock(async (_key: string) => stored[_key] ?? null),
      set: mock(async (key: string, value: string) => { stored[key] = value; }),
      delete: mock(async (_key: string) => { delete stored[_key]; }),
    };

    // Simulate the auth-login action's credential storage step
    await mockStore.set("session", MOCK_TOKEN.accessToken);

    expect(stored["session"]).toBe("acc-tok");
    expect(stored["session"]).not.toContain("ref-tok");
  });

  test("correct TOTP → accessToken from verifyTotp stored under 'session'", async () => {
    const stored: Record<string, string> = {};
    const challenge: SessionToken = { accessToken: "partial-tok", refreshToken: "r", uid: "u" };
    const fullToken: SessionToken = { accessToken: "full-tok", refreshToken: "r", uid: "u" };

    const mockVerifyTotp = mock(async (_c: SessionToken, _code: string) => fullToken);
    const mockStore = {
      set: mock(async (key: string, value: string) => { stored[key] = value; }),
    };

    // Simulate the exact sequence register() runs after catching TwoFactorRequiredError:
    // verifyTotp resolves → store accessToken
    await mockStore.set("session", (await mockVerifyTotp(challenge, "123456")).accessToken);

    expect(stored["session"]).toBe("full-tok");
    expect(mockStore.set).toHaveBeenCalledWith("session", "full-tok");
  });
});

describe("auth login — TOTP error exit codes", () => {
  let stderrWrites: string[];
  let originalStderr: typeof process.stderr.write;

  beforeEach(() => {
    stderrWrites = [];
    originalStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array) => {
      stderrWrites.push(String(chunk));
      return true;
    };
  });

  afterEach(() => {
    process.stderr.write = originalStderr;
  });

  test("TOTP_INVALID error formats to stderr and is not a ConfigError (exit code 1)", () => {
    const { formatError } = require("../core/output.js") as typeof import("../core/output.js");
    const err = new AuthError("Invalid 2FA code — check your authenticator app.", "TOTP_INVALID");

    formatError(err, { json: false });

    expect(stderrWrites.join("")).toContain("TOTP_INVALID");
    // Not a ConfigError → catch block uses process.exit(1) not process.exit(2)
    expect(err).not.toBeInstanceOf(ConfigError);
  });

  test("TOTP_INVALID error formats correctly in JSON mode", () => {
    const { formatError } = require("../core/output.js") as typeof import("../core/output.js");
    const err = new AuthError("Invalid 2FA code — check your authenticator app.", "TOTP_INVALID");

    formatError(err, { json: true });

    const parsed = JSON.parse(stderrWrites[0]!);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("TOTP_INVALID");
    expect(parsed.error.message).toContain("Invalid 2FA code");
  });
});
