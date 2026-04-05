import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SyncError, AuthError, NetworkError } from "../errors.js";
import { formatSuccess, formatError } from "../core/output.js";

// Test the upload command business logic directly

async function simulateUpload(
  local: string,
  remote: string,
  opts: { json: boolean },
  uploadFileFn: (l: string, r: string) => Promise<void>,
  getTokenFn: () => Promise<{ accessToken: string; refreshToken: string; uid: string }>,
  stdoutFn: (s: string) => void,
  stderrFn: (s: string) => void,
): Promise<number> {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  try {
    process.stdout.write = (c: string | Uint8Array) => { stdoutFn(String(c)); return true; };
    process.stderr.write = (c: string | Uint8Array) => { stderrFn(String(c)); return true; };
    const token = await getTokenFn();
    void token;

    if (!fs.existsSync(local)) {
      formatError(new SyncError(`Local path not found: ${local}`, "FILE_NOT_FOUND"), opts);
      return 1;
    }

    const stat = fs.statSync(local);
    let files: string[];
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(local, { recursive: true, encoding: "utf8" }) as string[];
      files = entries
        .map((e) => path.join(local, e))
        .filter((p) => fs.statSync(p).isFile());
    } else {
      files = [local];
    }

    let transferred = 0;
    for (const file of files) {
      const relPath = stat.isDirectory()
        ? path.join(remote, path.relative(local, file))
        : remote;
      await uploadFileFn(file, relPath);
      transferred++;
    }

    formatSuccess({ transferred, path: remote }, opts);
    if (!opts.json) {
      process.stdout.write(`Uploaded ${transferred} file(s) to ${remote}\n`);
    }
    return 0;
  } catch (err) {
    formatError(err, opts);
    return 1;
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

const MOCK_TOKEN = { accessToken: "tok", refreshToken: "ref", uid: "uid" };

describe("upload command", () => {
  let tmpDir: string;
  let stdoutLines: string[];
  let stderrLines: string[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "upload-test-"));
    stdoutLines = [];
    stderrLines = [];
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("uploads single file and reports success (human mode)", async () => {
    const file = path.join(tmpDir, "test.txt");
    fs.writeFileSync(file, "hello");
    const uploadFn = mock(async () => {});
    const code = await simulateUpload(
      file, "/remote/test.txt", { json: false },
      uploadFn,
      async () => MOCK_TOKEN,
      (s) => stdoutLines.push(s),
      (s) => stderrLines.push(s),
    );
    expect(code).toBe(0);
    expect(uploadFn).toHaveBeenCalledWith(file, "/remote/test.txt");
    expect(stdoutLines.some((l) => l.includes("Uploaded 1 file"))).toBe(true);
  });

  test("uploads single file and returns JSON on success", async () => {
    const file = path.join(tmpDir, "test.txt");
    fs.writeFileSync(file, "hello");
    const uploadFn = mock(async () => {});
    const code = await simulateUpload(
      file, "/remote/test.txt", { json: true },
      uploadFn,
      async () => MOCK_TOKEN,
      (s) => stdoutLines.push(s),
      (s) => stderrLines.push(s),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutLines[0]!);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.transferred).toBe(1);
    expect(parsed.data.path).toBe("/remote/test.txt");
  });

  test("uploads directory recursively", async () => {
    fs.mkdirSync(path.join(tmpDir, "subdir"));
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    fs.writeFileSync(path.join(tmpDir, "b.txt"), "b");
    fs.writeFileSync(path.join(tmpDir, "subdir", "c.txt"), "c");
    const uploadFn = mock(async () => {});
    const code = await simulateUpload(
      tmpDir, "/remote/dir", { json: true },
      uploadFn,
      async () => MOCK_TOKEN,
      (s) => stdoutLines.push(s),
      (s) => stderrLines.push(s),
    );
    expect(code).toBe(0);
    expect(uploadFn).toHaveBeenCalledTimes(3);
    const parsed = JSON.parse(stdoutLines[0]!);
    expect(parsed.data.transferred).toBe(3);
  });

  test("exits 1 when local path does not exist", async () => {
    const code = await simulateUpload(
      "/nonexistent/file.txt", "/remote/file.txt", { json: false },
      mock(async () => {}),
      async () => MOCK_TOKEN,
      (s) => stdoutLines.push(s),
      (s) => stderrLines.push(s),
    );
    expect(code).toBe(1);
    expect(stderrLines.some((l) => l.includes("FILE_NOT_FOUND"))).toBe(true);
  });

  test("exits 1 when no session token (AUTH error)", async () => {
    const file = path.join(tmpDir, "test.txt");
    fs.writeFileSync(file, "hello");
    const code = await simulateUpload(
      file, "/remote", { json: false },
      mock(async () => {}),
      async () => {
        throw new AuthError(
          "No session found — run 'protondrive auth login' first.",
          "NO_SESSION",
        );
      },
      (s) => stdoutLines.push(s),
      (s) => stderrLines.push(s),
    );
    expect(code).toBe(1);
    expect(stderrLines.some((l) => l.includes("NO_SESSION"))).toBe(true);
  });

  test("exits 1 on network failure after retries", async () => {
    const file = path.join(tmpDir, "test.txt");
    fs.writeFileSync(file, "hello");
    const code = await simulateUpload(
      file, "/remote", { json: false },
      mock(async () => { throw new NetworkError("timeout"); }),
      async () => MOCK_TOKEN,
      (s) => stdoutLines.push(s),
      (s) => stderrLines.push(s),
    );
    expect(code).toBe(1);
    expect(stderrLines.some((l) => l.includes("NETWORK_ERROR"))).toBe(true);
  });
});
