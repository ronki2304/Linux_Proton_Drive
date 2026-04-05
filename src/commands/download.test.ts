import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SyncError, AuthError, NetworkError } from "../errors.js";
import { formatSuccess, formatError } from "../core/output.js";

// Test atomic download pattern and command logic

async function simulateAtomicDownload(
  remotePath: string,
  localPath: string,
  downloadFn: (remote: string, tmp: string) => Promise<void>,
): Promise<void> {
  const tmpPath = localPath + ".protondrive-tmp";
  const dir = path.dirname(localPath);
  fs.mkdirSync(dir, { recursive: true });
  try {
    await downloadFn(remotePath, tmpPath);
    fs.renameSync(tmpPath, localPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

async function simulateDownload(
  remote: string,
  local: string,
  opts: { json: boolean },
  downloadFn: (r: string, l: string) => Promise<void>,
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
    await simulateAtomicDownload(remote, local, downloadFn);
    formatSuccess({ transferred: 1, path: local }, opts);
    if (!opts.json) {
      process.stdout.write(`Downloaded 1 file(s) to ${local}\n`);
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

describe("download command — atomic pattern", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "download-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("successful download writes file to local path", async () => {
    const localPath = path.join(tmpDir, "downloaded.txt");
    const downloadFn = mock(async (_remote: string, tmp: string) => {
      fs.writeFileSync(tmp, "downloaded content");
    });
    await simulateAtomicDownload("/remote/file.txt", localPath, downloadFn);
    expect(fs.existsSync(localPath)).toBe(true);
    expect(fs.readFileSync(localPath, "utf8")).toBe("downloaded content");
  });

  test("no temp file remains after successful download", async () => {
    const localPath = path.join(tmpDir, "clean.txt");
    const tmpPath = localPath + ".protondrive-tmp";
    const downloadFn = mock(async (_r: string, tmp: string) => {
      fs.writeFileSync(tmp, "data");
    });
    await simulateAtomicDownload("/remote/file.txt", localPath, downloadFn);
    expect(fs.existsSync(tmpPath)).toBe(false);
  });

  test("no temp file remains after failed download", async () => {
    const localPath = path.join(tmpDir, "failed.txt");
    const tmpPath = localPath + ".protondrive-tmp";
    const downloadFn = mock(async (_r: string, tmp: string) => {
      fs.writeFileSync(tmp, "partial");
      throw new NetworkError("connection reset");
    });
    let thrown = false;
    try {
      await simulateAtomicDownload("/remote/file.txt", localPath, downloadFn);
    } catch {
      thrown = true;
    }
    expect(thrown).toBe(true);
    expect(fs.existsSync(tmpPath)).toBe(false);
    expect(fs.existsSync(localPath)).toBe(false);
  });

  test("original file is not overwritten on failed download", async () => {
    const localPath = path.join(tmpDir, "existing.txt");
    fs.writeFileSync(localPath, "original content");
    const downloadFn = mock(async (_r: string, tmp: string) => {
      fs.writeFileSync(tmp, "new content");
      throw new NetworkError("network error");
    });
    try {
      await simulateAtomicDownload("/remote/file.txt", localPath, downloadFn);
    } catch {}
    expect(fs.readFileSync(localPath, "utf8")).toBe("original content");
  });

  test("creates parent directories on download", async () => {
    const localPath = path.join(tmpDir, "a", "b", "c", "file.txt");
    const downloadFn = mock(async (_r: string, tmp: string) => {
      fs.writeFileSync(tmp, "data");
    });
    await simulateAtomicDownload("/remote/file.txt", localPath, downloadFn);
    expect(fs.existsSync(localPath)).toBe(true);
  });
});

describe("download command — output", () => {
  let tmpDir: string;
  let stdoutLines: string[];
  let stderrLines: string[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "download-cmd-test-"));
    stdoutLines = [];
    stderrLines = [];
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("human mode reports success message", async () => {
    const localPath = path.join(tmpDir, "out.txt");
    const code = await simulateDownload(
      "/remote/out.txt", localPath, { json: false },
      mock(async (_r, tmp) => { fs.writeFileSync(tmp, "x"); }),
      async () => MOCK_TOKEN,
      (s) => stdoutLines.push(s),
      (s) => stderrLines.push(s),
    );
    expect(code).toBe(0);
    expect(stdoutLines.some((l) => l.includes("Downloaded 1 file"))).toBe(true);
  });

  test("JSON mode returns correct schema", async () => {
    const localPath = path.join(tmpDir, "out.txt");
    const code = await simulateDownload(
      "/remote/out.txt", localPath, { json: true },
      mock(async (_r, tmp) => { fs.writeFileSync(tmp, "x"); }),
      async () => MOCK_TOKEN,
      (s) => stdoutLines.push(s),
      (s) => stderrLines.push(s),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutLines[0]!);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.transferred).toBe(1);
    expect(parsed.data.path).toBe(localPath);
  });

  test("exits 1 when not authenticated", async () => {
    const localPath = path.join(tmpDir, "out.txt");
    const code = await simulateDownload(
      "/remote/out.txt", localPath, { json: false },
      mock(async () => {}),
      async () => { throw new AuthError("No session", "NO_SESSION"); },
      (s) => stdoutLines.push(s),
      (s) => stderrLines.push(s),
    );
    expect(code).toBe(1);
    expect(stderrLines.some((l) => l.includes("NO_SESSION"))).toBe(true);
  });

  test("exits 1 on network failure", async () => {
    const localPath = path.join(tmpDir, "out.txt");
    const code = await simulateDownload(
      "/remote/out.txt", localPath, { json: false },
      mock(async () => { throw new NetworkError("timeout"); }),
      async () => MOCK_TOKEN,
      (s) => stdoutLines.push(s),
      (s) => stderrLines.push(s),
    );
    expect(code).toBe(1);
  });

  test("exits 1 with REMOTE_NOT_FOUND when remote path does not exist", async () => {
    const localPath = path.join(tmpDir, "out.txt");
    const code = await simulateDownload(
      "/remote/missing.txt", localPath, { json: false },
      mock(async () => { throw new SyncError("Remote path not found", "REMOTE_NOT_FOUND"); }),
      async () => MOCK_TOKEN,
      (s) => stdoutLines.push(s),
      (s) => stderrLines.push(s),
    );
    expect(code).toBe(1);
    expect(stderrLines.some((l) => l.includes("REMOTE_NOT_FOUND"))).toBe(true);
  });
});
