/**
 * Integration tests — require real Proton credentials.
 * Excluded from default `bun test` run.
 *
 * Run manually:
 *   PROTON_TEST_USER=user@proton.me PROTON_TEST_PASS=secret bun test src/__integration__/
 *
 * For accounts with 2FA enabled, also set:
 *   PROTON_TEST_TOTP_SECRET=BASE32SECRET
 *
 * If Proton triggers a CAPTCHA challenge (bot detection), the test will pause and prompt
 * you to complete it interactively. In non-TTY/CI environments, set PROTON_HV_TOKEN to
 * a pre-completed token instead.
 */

import { describe, test, expect } from "bun:test";
import { createInterface } from "node:readline";
import { createHmac } from "node:crypto";
import { authenticate, verifyTotp } from "../auth/srp.js";
import { HumanVerificationRequiredError, TwoFactorRequiredError } from "../errors.js";
import type { SessionToken } from "../types.js";

const username = process.env["PROTON_TEST_USER"];
const password = process.env["PROTON_TEST_PASS"];
const totpSecret = process.env["PROTON_TEST_TOTP_SECRET"];
const hvToken = process.env["PROTON_HV_TOKEN"];
const SKIP = !username || !password;

async function resolveCaptcha(err: HumanVerificationRequiredError): Promise<{ humanVerificationToken: string; humanVerificationTokenType: string }> {
  if (!process.stdin.isTTY) {
    throw new Error(
      `Proton CAPTCHA required (non-interactive). Complete it at:\n  ${err.webUrl}\nThen re-run with: PROTON_HV_TOKEN=${err.verificationToken}`,
    );
  }
  process.stdout.write("\n");
  process.stdout.write("=".repeat(60) + "\n");
  process.stdout.write("⚠️  CAPTCHA REQUIRED\n");
  process.stdout.write("=".repeat(60) + "\n");
  process.stdout.write("Open this URL in your browser:\n\n");
  process.stdout.write(err.webUrl + "\n\n");
  process.stdout.write(`Token: ${err.verificationToken}\n`);
  process.stdout.write("=".repeat(60) + "\n");
  process.stdout.write("Press Enter after completing the CAPTCHA...\n");
  const rl = createInterface({ input: process.stdin, terminal: false });
  await new Promise<void>((resolve) => rl.once("line", () => { rl.close(); resolve(); }));
  return { humanVerificationToken: err.verificationToken, humanVerificationTokenType: "captcha" };
}

function decodeBase32(s: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleaned = s.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = "";
  for (const c of cleaned) {
    const idx = alphabet.indexOf(c);
    if (idx === -1) throw new Error(`Invalid base32 char: ${c}`);
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function computeTotp(secret: string): string {
  const key = decodeBase32(secret);
  const counter = Math.floor(Date.now() / 30000);
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[19]! & 0xf;
  const code =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return (code % 1_000_000).toString().padStart(6, "0");
}

async function authenticateWithTotp(): Promise<SessionToken> {
  let captchaOpts = hvToken ? { humanVerificationToken: hvToken, humanVerificationTokenType: "captcha" } : undefined;

  // First attempt — may trigger CAPTCHA
  try {
    return await authenticate(username!, password!, captchaOpts);
  } catch (firstErr) {
    if (firstErr instanceof HumanVerificationRequiredError) {
      captchaOpts = await resolveCaptcha(firstErr);
      // Fall through to retry loop with the completed token
    } else if (firstErr instanceof TwoFactorRequiredError) {
      if (!totpSecret) throw new Error("Account requires 2FA — set PROTON_TEST_TOTP_SECRET to the base32 secret from your authenticator app.");
      return verifyTotp(firstErr.challenge, computeTotp(totpSecret));
    } else {
      throw firstErr;
    }
  }

  // Retry with the same completed CAPTCHA token — Proton may need a moment to process the verification
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await authenticate(username!, password!, captchaOpts);
    } catch (err) {
      if (err instanceof HumanVerificationRequiredError) {
        // Keep the same completed token and retry after a short delay
        await new Promise<void>((r) => setTimeout(r, 2000));
        continue;
      }
      if (!(err instanceof TwoFactorRequiredError)) throw err;
      if (!totpSecret) throw new Error("Account requires 2FA — set PROTON_TEST_TOTP_SECRET to the base32 secret from your authenticator app.");
      return verifyTotp(err.challenge, computeTotp(totpSecret));
    }
  }
  throw new Error("Authentication failed after multiple retries with completed CAPTCHA token — Proton may be persistently rate-limiting this account.");
}

describe("SRP authenticate (live Proton API)", () => {
  test.skipIf(SKIP)(
    "returns a valid SessionToken with non-empty accessToken",
    async () => {
      const token = await authenticateWithTotp();
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
