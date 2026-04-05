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
 *   - No 2FA on the test account (v1 limitation)
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "node:crypto";
import { authenticate } from "../auth/srp.js";
import { createLiveDriveClient, type DriveClient } from "../sdk/client.js";
import { StateDB } from "../core/state-db.js";
import { SyncEngine } from "../core/sync-engine.js";
import type { SessionToken } from "../types.js";

const username = process.env["PROTON_TEST_USER"];
const password = process.env["PROTON_TEST_PASS"];
const SKIP = !username || !password;

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
  token = await authenticate(username!, password!);
  driveClient = await createLiveDriveClient(token, password!);
  localTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "protondrive-int-"));
  // Create remote test folder
  await driveClient.createFolder(TEST_REMOTE_BASE);
});

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
