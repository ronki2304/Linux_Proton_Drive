/**
 * Live sync integration tests — require real Proton credentials.
 * Excluded from default `bun test` run.
 *
 * Run manually:
 *   PROTON_TEST_USER=user@proton.me PROTON_TEST_PASS=secret bun test src/__integration__/
 *
 * What is tested:
 *   - Full upload → remote-verify → download byte-for-byte integrity (AC3)
 *   - Conflict detection and conflict copy creation (AC4)
 *   - Test data cleanup from ProtonDrive account (AC5)
 *
 * Prerequisites:
 *   - Real Proton account (test account recommended, not primary)
 *   - For accounts with 2FA, also set PROTON_TEST_TOTP_SECRET
 *
 * If Proton triggers a CAPTCHA challenge (bot detection), the test will pause and prompt
 * you to complete it interactively. In non-TTY/CI environments, set PROTON_HV_TOKEN to
 * a pre-completed token instead.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createInterface } from "node:readline";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash, createHmac } from "node:crypto";
import { authenticate, verifyTotp } from "../auth/srp.js";
import { HumanVerificationRequiredError, TwoFactorRequiredError } from "../errors.js";
import { createLiveDriveClient, type DriveClient } from "../sdk/client.js";
import { StateDB } from "../core/state-db.js";
import { SyncEngine } from "../core/sync-engine.js";
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

// Unique remote test folder scoped to root — prevents collisions between runs
// and avoids leaving an orphaned /integration-tests/ parent folder in the account.
const TEST_FOLDER_NAME = `protondrive-e2e-${Date.now()}`;
const TEST_REMOTE_BASE = `/${TEST_FOLDER_NAME}`;

let token: SessionToken;
let driveClient: DriveClient;
let localTmpDir: string;

function sha256File(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return createHash("sha256").update(data).digest("hex");
}

beforeAll(async () => {
  if (SKIP) return;
  token = await authenticateWithTotp();
  driveClient = await createLiveDriveClient(token, password!);
  localTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "protondrive-int-"));
  // Create remote test folder
  await driveClient.createFolder(TEST_REMOTE_BASE);
}, 120_000); // 2 min — allows for interactive CAPTCHA resolution

afterAll(async () => {
  if (SKIP) return;
  // Clean up remote test data (AC5) — guard on driveClient in case beforeAll failed partway
  if (driveClient) {
    try {
      await driveClient.deleteNode(`/${TEST_FOLDER_NAME}`);
    } catch {
      // best effort — session may have expired during a long test run
    }
  }
  // Clean up local temp dir
  if (localTmpDir) {
    try {
      fs.rmSync(localTmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

describe("DriveClient live integration (ProtonDrive API)", () => {
  test.skipIf(SKIP)(
    "upload → remote-verify → download: file is byte-for-byte identical",
    async () => {
      // Prepare a test file with known content
      const testContent = Buffer.from(
        `integration-test-content-${Date.now()}\n`.repeat(10),
        "utf8",
      );
      const localUploadPath = path.join(localTmpDir, "upload-test.txt");
      const localDownloadPath = path.join(localTmpDir, "download-test.txt");
      fs.writeFileSync(localUploadPath, testContent);

      const remotePath = `${TEST_REMOTE_BASE}/upload-test.txt`;

      // Upload
      await driveClient.uploadFile(localUploadPath, remotePath);

      // Remote verify — file should appear in folder listing
      const listing = await driveClient.listFolder(TEST_REMOTE_BASE);
      const remoteFile = listing.find((item) => item.name === "upload-test.txt");
      expect(remoteFile).toBeDefined();
      expect(remoteFile?.isFolder).toBe(false);

      // Download
      await driveClient.downloadFile(remotePath, localDownloadPath);

      // Byte-for-byte comparison
      expect(fs.existsSync(localDownloadPath)).toBe(true);
      const uploadedHash = sha256File(localUploadPath);
      const downloadedHash = sha256File(localDownloadPath);
      expect(downloadedHash).toBe(uploadedHash);
    },
    60_000,
  );

  test.skipIf(SKIP)(
    "conflict detection: two conflicting local changes produce a conflict copy",
    async () => {
      const stateDbPath = path.join(localTmpDir, "state.db");
      const localSyncDir = path.join(localTmpDir, "sync-local");
      const remoteBasePath = `${TEST_REMOTE_BASE}/conflict-test`;
      fs.mkdirSync(localSyncDir, { recursive: true });

      // 1. Create initial file and upload it
      const conflictFileName = "conflict-file.txt";
      const localFilePath = path.join(localSyncDir, conflictFileName);
      const remotePath = `${remoteBasePath}/${conflictFileName}`;
      fs.writeFileSync(localFilePath, "original content\n");
      await driveClient.createFolder(remoteBasePath);
      await driveClient.uploadFile(localFilePath, remotePath);

      // 2. Record "synced" state in StateDB — simulates a previous successful sync
      const db = await StateDB.init(stateDbPath);
      const syncPair = { id: "conflict-pair", local: localSyncDir, remote: remoteBasePath };
      const fileStat = fs.statSync(localFilePath);
      db.upsert({
        syncPairId: "conflict-pair",
        localPath: localFilePath,
        remotePath,
        lastSyncMtime: fileStat.mtime.toISOString(),
        lastSyncHash: sha256File(localFilePath),
        state: "synced",
      });
      db.close();

      // 3. Modify local file (simulates user editing locally)
      fs.writeFileSync(localFilePath, "modified locally\n");

      // 4. Upload a different version to the remote (simulates a remote change from another client)
      const remoteConflictPath = remotePath; // overwrite same remote path
      const tempRemoteContent = path.join(localTmpDir, "remote-version.txt");
      fs.writeFileSync(tempRemoteContent, "modified remotely\n");
      await driveClient.uploadFile(tempRemoteContent, remoteConflictPath);

      // 5. Run SyncEngine with a controlled client that guarantees the remote mtime reflects
      // the second upload — avoids ProtonDrive API eventual consistency races
      const forcedRemoteMtime = new Date(Date.now() + 30_000).toISOString();
      // Object.create preserves prototype methods (uploadFile, downloadFile, etc.)
      // while allowing listFolder to be overridden on the instance.
      const controlledClient = Object.create(driveClient) as typeof driveClient;
      controlledClient.listFolder = async (remotePath: string) => {
        const items = await driveClient.listFolder(remotePath);
        return items.map((item) =>
          item.name === conflictFileName ? { ...item, mtime: forcedRemoteMtime } : item,
        );
      };

      const freshDb = await StateDB.init(stateDbPath);
      const engine = new SyncEngine(freshDb);
      const syncResult = await engine.run([syncPair], token, controlledClient);
      freshDb.close();

      // Conflict copy should have been created (AC4)
      const localFiles = fs.readdirSync(localSyncDir);
      const conflictCopy = localFiles.find(
        (f) => f.startsWith("conflict-file") && f !== conflictFileName,
      );
      expect(conflictCopy).toBeDefined();

      // SyncEngine must track the conflict in its result (AC4)
      expect(syncResult.conflicts.length).toBeGreaterThan(0);
      expect(syncResult.conflicts[0]).toHaveProperty("conflictCopy");
    },
    90_000,
  );

  test.skipIf(!SKIP)("skipped — set PROTON_TEST_USER and PROTON_TEST_PASS to run", () => {
    expect(SKIP).toBe(true);
  });
});
