#!/usr/bin/env bun
/**
 * Standalone key-decryption probe — runs outside Flatpak from terminal.
 *
 * Usage:
 *   1. Get your stored auth token from GNOME Keyring:
 *        secret-tool lookup app ProtonDriveLinuxClient type session-token
 *   2. Run:
 *        cd engine
 *        TOKEN="<uid>:<accesstoken>" bun scripts/probe-key-decrypt.ts
 *      The script prompts for your Proton password interactively (not logged).
 *
 * What it tests:
 *   - Per-key bcrypt derivation ($2y$10$ prefix) using /core/v4/keys/salts
 *   - Per-key bcrypt derivation ($2b$10$ prefix)
 *   - Raw password (no bcrypt) — two-password mode mailbox password
 *   - NFC/NFD Unicode normalisation variants
 *   - Reports key packet S2K info and whether each strategy decrypts
 */

import * as openpgp from "openpgp";
import bcrypt from "bcryptjs";
import * as readline from "node:readline";
import { pbkdf2Sync, createDecipheriv } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Read token from the Flatpak app's EncryptedFileStore
// (used when the Flatpak sandbox can't reach the GNOME Keyring D-Bus)
// ---------------------------------------------------------------------------
function readFromEncryptedFileStore(): string | null {
  const APP_ID = "io.github.ronki2304.ProtonDriveLinuxClient";
  const dir = join(homedir(), ".var/app", APP_ID, "data", "keyrings");
  try {
    const salt = readFileSync(join(dir, "salt.bin"));
    const fernetToken = readFileSync(join(dir, "session.enc")).toString("utf8").trim();
    const machineId = Buffer.from(readFileSync("/etc/machine-id").toString().trim());

    // Replicate credential_store.py _derive_key():
    //   PBKDF2-SHA256(machine_id + APP_ID, salt, 600_000) → 32 bytes
    const keyMaterial = Buffer.concat([machineId, Buffer.from(APP_ID)]);
    const rawKey = pbkdf2Sync(keyMaterial, salt, 600_000, 32, "sha256");

    // Fernet token is base64url-encoded; structure after decoding:
    //   version[1=0x80] + timestamp[8] + iv[16] + ciphertext[n*16] + hmac[32]
    // Encryption key = last 16 bytes of rawKey (signing key = first 16, unused here)
    const decoded = Buffer.from(fernetToken, "base64url");
    if (decoded.length < 57) throw new Error(`token too short: ${decoded.length}`);
    const iv = decoded.subarray(9, 25);
    const ciphertext = decoded.subarray(25, decoded.length - 32);
    const encKey = rawKey.subarray(16, 32);

    const decipher = createDecipheriv("aes-128-cbc", encKey, iv);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (e) {
    console.log(`EncryptedFileStore: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Token parsing
// ---------------------------------------------------------------------------
let TOKEN_RAW = process.env["TOKEN"] ?? "";

// Also accept a token file path via TOKEN_FILE env var
if (!TOKEN_RAW && process.env["TOKEN_FILE"]) {
  const { readFileSync } = await import("node:fs");
  TOKEN_RAW = readFileSync(process.env["TOKEN_FILE"]!, "utf8").trim();
}

// If still no token, try secret-tool (GNOME Keyring)
if (!TOKEN_RAW) {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync("secret-tool", [
    "lookup", "app", "ProtonDriveLinuxClient", "type", "session-token"
  ], { encoding: "utf8" });
  const candidate = (result.stdout ?? "").trim();
  // Only use if it looks like a full uid:token (contains colon) or is long enough
  if (candidate && (candidate.includes(":") || candidate.length > 50)) {
    TOKEN_RAW = candidate;
    console.log(`Token loaded from GNOME Keyring (len=${TOKEN_RAW.length})`);
  } else if (candidate) {
    console.log(`GNOME Keyring has short token (len=${candidate.length}) — likely stale, trying file store`);
  }
}

// If still no token, try the EncryptedFileStore that the Flatpak app uses
if (!TOKEN_RAW) {
  const candidate = readFromEncryptedFileStore();
  if (candidate) {
    TOKEN_RAW = candidate;
    console.log(`Token loaded from EncryptedFileStore (len=${TOKEN_RAW.length})`);
  }
}

if (!TOKEN_RAW) {
  console.error(
    "No token found. Run the app and log in first, then re-run this script.\n" +
    "Or: TOKEN=\"uid:accesstoken\" bun scripts/probe-key-decrypt.ts\n"
  );
  process.exit(1);
}

const colonIdx = TOKEN_RAW.indexOf(":");
const uid = colonIdx > 0 ? TOKEN_RAW.slice(0, colonIdx) : undefined;
const token = colonIdx > 0 ? TOKEN_RAW.slice(colonIdx + 1) : TOKEN_RAW;

function makeHeaders(): Headers {
  const h = new Headers();
  h.set("Authorization", `Bearer ${token}`);
  if (uid) h.set("x-pm-uid", uid);
  h.set("x-pm-appversion", "web-drive@5.0.0.0");
  h.set("Accept", "application/vnd.protonmail.v1+json");
  return h;
}

// ---------------------------------------------------------------------------
// bcrypt base64 encoder — identical to sdk.ts
// ---------------------------------------------------------------------------
const BCRYPT_B64 =
  "./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function encodeToBcryptBase64(buf: Buffer): string {
  let result = "";
  let c1: number, c2: number;
  let off = 0;
  while (off < buf.length) {
    c1 = buf[off++]! & 0xff;
    result += BCRYPT_B64[c1 >> 2]!;
    c1 = (c1 & 0x03) << 4;
    if (off >= buf.length) { result += BCRYPT_B64[c1]!; break; }
    c2 = buf[off++]! & 0xff;
    c1 |= c2 >> 4;
    result += BCRYPT_B64[c1]!;
    c1 = (c2 & 0x0f) << 2;
    if (off >= buf.length) { result += BCRYPT_B64[c1]!; break; }
    c2 = buf[off++]! & 0xff;
    c1 |= c2 >> 6;
    result += BCRYPT_B64[c1]!;
    result += BCRYPT_B64[c2 & 0x3f]!;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function prompt(question: string): Promise<string> {
  // Read password without echoing
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // Disable echoing if possible (TTY)
  if ("setRawMode" in process.stdin && typeof (process.stdin as NodeJS.ReadStream).setRawMode === "function") {
    (process.stdin as NodeJS.ReadStream).setRawMode(true);
  }
  process.stdout.write(question);
  return new Promise((resolve) => {
    let pw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (ch) => {
      ch = String(ch);
      if (ch === "\n" || ch === "\r" || ch === "\u0004") {
        process.stdout.write("\n");
        rl.close();
        resolve(pw);
      } else if (ch === "\u0008" || ch === "\u007f") {
        if (pw.length > 0) { pw = pw.slice(0, -1); }
      } else {
        pw += ch;
      }
    });
    process.stdin.resume();
  });
}

async function tryDecrypt(
  privateKey: openpgp.PrivateKey,
  passphrase: string,
  label: string
): Promise<boolean> {
  try {
    await openpgp.decryptKey({ privateKey, passphrase });
    console.log(`  ✓  DECRYPTED with: ${label}`);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  ✗  failed (${label}): ${msg}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const password = process.env["PROTON_PASSWORD"] ?? await prompt("Proton password (not echoed): ");
  console.log(`\nPassword received: length=${password.length} firstCharCode=${password.charCodeAt(0)}`);

  // PROBE_SALT env var: supply the KeySalt (base64) manually to bypass the API.
  // Get it from a fresh login session log: look for "captured auth KeySalt" in stderr.
  const envSalt = process.env["PROBE_SALT"];

  // --- Fetch per-key salts ---
  // NOTE: /core/v4/keys/salts requires "locked" scope (only present during the
  // initial auth handshake before key unlock). Post-auth browser tokens won't have
  // it. If it fails, fall back to /core/v4/auth/info for the session-level KeySalt.
  // Last resort: set PROBE_SALT=<base64> env var to supply it manually.
  console.log("\n=== GET /core/v4/keys/salts ===");
  const saltsResp = await fetch("https://drive-api.proton.me/core/v4/keys/salts", {
    headers: makeHeaders(),
  });
  let saltMap = new Map<string, string | null>();
  let fallbackKeySalt: string | null | undefined = undefined; // set if we fall back to auth/info
  if (!saltsResp.ok) {
    const body = await saltsResp.text();
    console.error(`keys/salts HTTP ${saltsResp.status}: ${body.slice(0, 300)}`);
    // Fallback: try /core/v4/auth/info for session-level KeySalt
    console.log("\n=== Fallback: GET /core/v4/auth/info (session KeySalt) ===");
    const infoResp = await fetch("https://drive-api.proton.me/core/v4/auth/info", {
      headers: makeHeaders(),
    });
    if (infoResp.ok) {
      const infoJson = (await infoResp.json()) as { KeySalt?: string | null; PasswordMode?: number };
      fallbackKeySalt = infoJson.KeySalt ?? null;
      console.log(`  PasswordMode: ${infoJson.PasswordMode}`);
      console.log(`  KeySalt: ${fallbackKeySalt === null ? "null (SSO)" : fallbackKeySalt === undefined ? "absent" : `"${fallbackKeySalt.slice(0, 12)}..." (len=${fallbackKeySalt.length})`}`);
      console.log(`  (will apply to all keys as fallback salt)`);
    } else {
      const b2 = await infoResp.text();
      console.error(`auth/info HTTP ${infoResp.status}: ${b2.slice(0, 300)}`);
      // Use PROBE_SALT env var if set, otherwise prompt interactively
      if (envSalt) {
        fallbackKeySalt = envSalt;
        console.log(`  Using PROBE_SALT env var: "${fallbackKeySalt.slice(0, 12)}..." (len=${fallbackKeySalt.length})`);
      } else {
        console.log(`\n  Cannot fetch KeySalt via API (requires locked-scope token from fresh login).`);
        const saltInput = await prompt("  Paste KeySalt (base64, from previous probe run or login log), or press Enter to skip: ");
        if (saltInput.trim()) {
          fallbackKeySalt = saltInput.trim();
          console.log(`  Using manually entered KeySalt (len=${fallbackKeySalt.length})`);
        }
      }
    }
  } else {
    const saltsJson = (await saltsResp.json()) as {
      KeySalts?: Array<{ ID: string; KeySalt: string | null }>;
    };
    for (const s of saltsJson.KeySalts ?? []) {
      saltMap.set(s.ID, s.KeySalt);
      console.log(`  Key ${s.ID}: KeySalt=${s.KeySalt ? `"${s.KeySalt.slice(0, 12)}..." (len=${s.KeySalt.length})` : "null"}`);
    }
    console.log(`  Total: ${saltMap.size} salt(s) in map`);
    if (envSalt) {
      fallbackKeySalt = envSalt;
      console.log(`  PROBE_SALT env var set — will use as fallback for missing keys`);
    }
  }

  // --- Fetch user keys ---
  console.log("\n=== GET /core/v4/users (user keys) ===");
  const usersResp = await fetch("https://drive-api.proton.me/core/v4/users", {
    headers: makeHeaders(),
  });
  let userKeys: Array<{ ID: string; PrivateKey: string; Primary?: number }> = [];
  if (!usersResp.ok) {
    const body = await usersResp.text();
    console.error(`users HTTP ${usersResp.status}: ${body.slice(0, 300)}`);
  } else {
    const usersJson = (await usersResp.json()) as {
      User?: { Keys?: Array<{ ID: string; PrivateKey: string; Primary?: number }> };
    };
    userKeys = usersJson.User?.Keys ?? [];
    console.log(`  Got ${userKeys.length} user key(s)`);
  }

  // --- Try address keys if no user keys ---
  if (userKeys.length === 0) {
    console.log("\n=== Falling back to GET /core/v4/addresses ===");
    const addrResp = await fetch("https://drive-api.proton.me/core/v4/addresses", {
      headers: makeHeaders(),
    });
    if (addrResp.ok) {
      const addrJson = (await addrResp.json()) as {
        Addresses?: Array<{ Keys?: Array<{ ID: string; PrivateKey: string; Token: string | null }> }>;
      };
      for (const addr of addrJson.Addresses ?? []) {
        for (const k of addr.Keys ?? []) {
          if (k.Token === null) {
            userKeys.push({ ID: k.ID, PrivateKey: k.PrivateKey });
          }
        }
      }
      console.log(`  Got ${userKeys.length} v2 address key(s)`);
    }
  }

  if (userKeys.length === 0) {
    console.error("No keys found — cannot test decryption");
    process.exit(1);
  }

  // --- Test each key ---
  for (let i = 0; i < userKeys.length; i++) {
    const k = userKeys[i]!;
    console.log(`\n====== Key ${i + 1}/${userKeys.length}: ID=${k.ID} Primary=${k.Primary ?? 0} ======`);

    // Parse the OpenPGP private key
    let privateKey: openpgp.PrivateKey;
    try {
      privateKey = await openpgp.readPrivateKey({ armoredKey: k.PrivateKey });
    } catch (e) {
      console.error(`  ERROR parsing key: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    // Log key internals
    const kp = privateKey.keyPacket as unknown as {
      s2k?: { type?: string; algorithm?: number; c?: number; count?: number; mode?: string };
      symmetric?: number;
      version?: number;
      aeadAlgorithm?: number;
    };
    console.log(`  OpenPGP: v=${kp.version} s2k=${kp.s2k?.type} s2kAlgo=${kp.s2k?.algorithm} ` +
      `s2kCount=${kp.s2k?.count ?? kp.s2k?.c} sym=${kp.symmetric} aead=${kp.aeadAlgorithm ?? "none"}`);
    console.log(`  isDecrypted: ${privateKey.isDecrypted()}`);

    // Prefer per-key salt from map; fall back to session-level salt from auth/info
    let salt = saltMap.has(k.ID) ? saltMap.get(k.ID)! : undefined;
    if (salt === undefined && fallbackKeySalt !== undefined) {
      salt = fallbackKeySalt;
      console.log(`  Salt lookup: NOT IN MAP — using fallback session KeySalt`);
    } else {
      console.log(`  Salt lookup: ${salt === undefined ? "NOT IN MAP" : salt === null ? "null (SSO)" : `"${salt}"`}`);
    }

    if (privateKey.isDecrypted()) {
      console.log("  Key is already decrypted (no passphrase needed) ✓");
      continue;
    }

    if (salt === null) {
      // SSO: try empty passphrase
      await tryDecrypt(privateKey, "", "empty passphrase (SSO key)");
      continue;
    }

    const candidates: Array<[string, string]> = [];

    if (salt !== undefined) {
      const rawSalt = Buffer.from(salt, "base64");
      const saltSuffix = encodeToBcryptBase64(rawSalt);
      console.log(`  bcrypt salt suffix: "${saltSuffix}" (len=${saltSuffix.length})`);

      // Proton's computeKeyPassword: bcrypt then .slice(29) — pm-srp/lib/keys.js
      const saltY = `$2y$10$${saltSuffix}`;
      const kpY = (await bcrypt.hash(password, saltY)).slice(29);
      console.log(`  keyPassword (slice(29)) → "${kpY}" len=${kpY.length}`);
      candidates.push([kpY, "bcrypt $2y$10$ .slice(29)"]);

      // NFC-normalized password
      const pwNFC = password.normalize("NFC");
      if (pwNFC !== password) {
        console.log(`  Note: NFC normalization changes the password!`);
        const kpNFC = (await bcrypt.hash(pwNFC, saltY)).slice(29);
        candidates.push([kpNFC, "bcrypt $2y$10$ .slice(29) (NFC password)"]);
      }

      // NFD-normalized password
      const pwNFD = password.normalize("NFD");
      if (pwNFD !== password) {
        console.log(`  Note: NFD normalization changes the password!`);
        const kpNFD = (await bcrypt.hash(pwNFD, saltY)).slice(29);
        candidates.push([kpNFD, "bcrypt $2y$10$ .slice(29) (NFD password)"]);
      }
    }

    // Raw password (no bcrypt) — two-password mode mailbox password
    candidates.push([password, "raw password (no bcrypt)"]);

    // NFC/NFD raw variants (two-password mode)
    const pwNFC2 = password.normalize("NFC");
    if (pwNFC2 !== password) candidates.push([pwNFC2, "raw NFC password"]);
    const pwNFD2 = password.normalize("NFD");
    if (pwNFD2 !== password) candidates.push([pwNFD2, "raw NFD password"]);

    console.log(`\n  --- Trying ${candidates.length} passphrase candidate(s) ---`);
    let anySuccess = false;
    for (const [passphrase, label] of candidates) {
      const ok = await tryDecrypt(privateKey, passphrase, label);
      if (ok) { anySuccess = true; break; }
    }
    if (!anySuccess) {
      console.log("\n  *** All candidates failed for this key ***");
      console.log("  Possible causes:");
      console.log("    1. Wrong password (two-password mode: enter MAILBOX password, not login password)");
      console.log("    2. Password derived differently (e.g. auth response KeySalt vs per-key salts)");
      console.log("    3. Unsupported key format");
    }
  }

  console.log("\n=== Done ===");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
