/**
 * Integration tests — require real Proton credentials.
 * Excluded from default `bun test` run.
 *
 * Run manually:
 *   PROTON_TEST_USER=user@proton.me PROTON_TEST_PASS=secret bun test src/__integration__/
 */

import { describe, test, expect } from "bun:test";
import { authenticate } from "../auth/srp.js";

const username = process.env["PROTON_TEST_USER"];
const password = process.env["PROTON_TEST_PASS"];
const SKIP = !username || !password;

describe("SRP authenticate (live Proton API)", () => {
  test.skipIf(SKIP)(
    "returns a valid SessionToken with non-empty accessToken",
    async () => {
      const token = await authenticate(username!, password!);
      expect(typeof token.accessToken).toBe("string");
      expect(token.accessToken.length).toBeGreaterThan(0);
      expect(typeof token.refreshToken).toBe("string");
      expect(token.refreshToken.length).toBeGreaterThan(0);
      expect(typeof token.uid).toBe("string");
      expect(token.uid.length).toBeGreaterThan(0);
    },
    60_000,
  );

  test.skipIf(!SKIP)("skipped — set PROTON_TEST_USER and PROTON_TEST_PASS to run", () => {
    // This test is a placeholder shown when credentials are missing
    expect(SKIP).toBe(true);
  });
});
