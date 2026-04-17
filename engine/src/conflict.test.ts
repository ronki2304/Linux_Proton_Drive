import { describe, it, expect } from "bun:test";
import { detectConflict } from "./conflict.js";

const T0     = "2026-04-10T10:00:00.000Z";   // stored/baseline mtime
const T1     = "2026-04-10T11:00:00.000Z";   // clearly changed local mtime
const T2     = "2026-04-10T12:00:00.000Z";   // clearly changed remote mtime
const T0_MS  = "2026-04-10T10:00:00.500Z";   // same second as T0, different ms (sub-second)
const HASH_A = "aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222";
const HASH_B = "bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222cccc3333";

describe("detectConflict", () => {
  it("both sides changed (clear divergence) → isConflict=true, reason=both_changed", () => {
    expect(detectConflict(T1, T0, T2, T0, null, null)).toEqual({ isConflict: true, reason: "both_changed" });
  });

  it("same-second mtime, hashes differ → isConflict=true, reason=same_second_hash_mismatch", () => {
    expect(detectConflict(T0_MS, T0, T0_MS, T0, HASH_A, HASH_B)).toEqual({
      isConflict: true,
      reason: "same_second_hash_mismatch",
    });
  });

  it("same-second mtime, hashes match → isConflict=false (touch-only change)", () => {
    expect(detectConflict(T0_MS, T0, T0_MS, T0, HASH_A, HASH_A)).toEqual({ isConflict: false });
  });

  it("same-second mtime, storedHash=null → isConflict=true, reason=hash_unavailable", () => {
    expect(detectConflict(T0_MS, T0, T0_MS, T0, null, HASH_A)).toEqual({
      isConflict: true,
      reason: "hash_unavailable",
    });
  });

  it("same-second mtime, currentLocalHash=null → isConflict=true, reason=hash_unavailable", () => {
    expect(detectConflict(T0_MS, T0, T0_MS, T0, HASH_A, null)).toEqual({
      isConflict: true,
      reason: "hash_unavailable",
    });
  });

  it("local-only changed → isConflict=false", () => {
    expect(detectConflict(T1, T0, T0, T0, null, null)).toEqual({ isConflict: false });
  });

  it("remote-only changed → isConflict=false", () => {
    expect(detectConflict(T0, T0, T2, T0, null, null)).toEqual({ isConflict: false });
  });

  it("neither changed → isConflict=false", () => {
    expect(detectConflict(T0, T0, T0, T0, null, null)).toEqual({ isConflict: false });
  });
});
