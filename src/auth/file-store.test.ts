import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FileStore } from "./file-store.js";

describe("FileStore", () => {
  let tmpDir: string;
  let store: FileStore;
  let originalXdgDataHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "filestore-test-"));
    originalXdgDataHome = process.env["XDG_DATA_HOME"];
    process.env["XDG_DATA_HOME"] = tmpDir;
    store = new FileStore();
  });

  afterEach(() => {
    if (originalXdgDataHome === undefined) {
      delete process.env["XDG_DATA_HOME"];
    } else {
      process.env["XDG_DATA_HOME"] = originalXdgDataHome;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("get returns null when no credential is stored", async () => {
    expect(await store.get("session")).toBeNull();
  });

  test("set + get round-trip returns stored value", async () => {
    await store.set("session", "my-access-token");
    expect(await store.get("session")).toBe("my-access-token");
  });

  test("set creates parent directories if they do not exist", async () => {
    const credDir = path.join(tmpDir, "protondrive");
    expect(fs.existsSync(credDir)).toBe(false);
    await store.set("session", "token");
    expect(fs.existsSync(credDir)).toBe(true);
  });

  test("credentials file has 0600 permissions", async () => {
    await store.set("session", "secret-token");
    const credFile = path.join(tmpDir, "protondrive", "credentials.session");
    const stats = fs.statSync(credFile);
    // 0o600 = S_IRUSR | S_IWUSR = 384
    expect(stats.mode & 0o777).toBe(0o600);
  });

  test("delete removes the credential file", async () => {
    await store.set("session", "token");
    const credFile = path.join(tmpDir, "protondrive", "credentials.session");
    expect(fs.existsSync(credFile)).toBe(true);
    await store.delete("session");
    expect(fs.existsSync(credFile)).toBe(false);
  });

  test("delete is idempotent on missing credential", async () => {
    await expect(store.delete("nonexistent")).resolves.toBeUndefined();
  });

  test("get returns null after delete", async () => {
    await store.set("session", "token");
    await store.delete("session");
    expect(await store.get("session")).toBeNull();
  });

  test("multiple keys stored in separate files", async () => {
    await store.set("session", "access-token");
    await store.set("refresh", "refresh-token");
    expect(await store.get("session")).toBe("access-token");
    expect(await store.get("refresh")).toBe("refresh-token");
    // Each key gets its own file
    expect(fs.existsSync(path.join(tmpDir, "protondrive", "credentials.session"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "protondrive", "credentials.refresh"))).toBe(true);
  });

  test("overwrite updates the stored value", async () => {
    await store.set("session", "old-token");
    await store.set("session", "new-token");
    expect(await store.get("session")).toBe("new-token");
  });
});
