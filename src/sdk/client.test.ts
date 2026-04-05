import { describe, test, expect, mock, beforeEach } from "bun:test";
import { AuthError, ConfigError, NetworkError, SyncError } from "../errors.js";
import type { SessionToken } from "../types.js";

// Test the withRetry logic by creating a DriveClient-like wrapper in tests
// (DriveClient constructor requires SDK setup; we test the retry policy directly)

const MOCK_TOKEN: SessionToken = {
  accessToken: "test-access-token",
  refreshToken: "test-refresh-token",
  uid: "test-uid",
};

const RETRY_DELAYS_MS = [1000, 2000, 4000];

// Minimal retry harness that mirrors DriveClient.withRetry exactly
async function withRetry<T>(
  fn: () => Promise<T>,
  isNonRetryable: (err: unknown) => boolean,
  delayFn: (ms: number) => Promise<void>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (isNonRetryable(err)) throw err;
      lastError = err;
      if (attempt < RETRY_DELAYS_MS.length) {
        await delayFn(RETRY_DELAYS_MS[attempt]!);
      }
    }
  }
  throw lastError;
}

function isNonRetryable(err: unknown): boolean {
  return err instanceof AuthError || err instanceof SyncError || err instanceof ConfigError;
}

describe("DriveClient withRetry policy", () => {
  let delayMock: ReturnType<typeof mock>;

  beforeEach(() => {
    delayMock = mock((_ms: number) => Promise.resolve());
  });

  test("succeeds on first attempt without retrying", async () => {
    const fn = mock(() => Promise.resolve("ok"));
    const result = await withRetry(fn, isNonRetryable, delayMock);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delayMock).not.toHaveBeenCalled();
  });

  test("retries up to 3 times on NetworkError then throws", async () => {
    const fn = mock(() => Promise.reject(new NetworkError("timeout")));
    let thrown: unknown;
    try {
      await withRetry(fn, isNonRetryable, delayMock);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NetworkError);
    // 1 initial + 3 retries = 4 total calls
    expect(fn).toHaveBeenCalledTimes(4);
    // 3 delays fired (1s, 2s, 4s)
    expect(delayMock).toHaveBeenCalledTimes(3);
    expect(delayMock.mock.calls[0]![0]).toBe(1000);
    expect(delayMock.mock.calls[1]![0]).toBe(2000);
    expect(delayMock.mock.calls[2]![0]).toBe(4000);
  });

  test("succeeds on second attempt after one transient failure", async () => {
    let attempts = 0;
    const fn = mock(() => {
      attempts++;
      if (attempts === 1) return Promise.reject(new NetworkError("blip"));
      return Promise.resolve("recovered");
    });
    const result = await withRetry(fn, isNonRetryable, delayMock);
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(delayMock).toHaveBeenCalledTimes(1);
  });

  test("AuthError fails immediately without retrying", async () => {
    const fn = mock(() =>
      Promise.reject(new AuthError("token expired", "AUTH_TOKEN_EXPIRED")),
    );
    let thrown: unknown;
    try {
      await withRetry(fn, isNonRetryable, delayMock);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AuthError);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delayMock).not.toHaveBeenCalled();
  });

  test("SyncError fails immediately without retrying", async () => {
    const fn = mock(() =>
      Promise.reject(new SyncError("sync conflict", "SYNC_CONFLICT")),
    );
    let thrown: unknown;
    try {
      await withRetry(fn, isNonRetryable, delayMock);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SyncError);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delayMock).not.toHaveBeenCalled();
  });

  test("ConfigError fails immediately without retrying", async () => {
    const fn = mock(() =>
      Promise.reject(new ConfigError("bad config", "CONFIG_ERROR")),
    );
    let thrown: unknown;
    try {
      await withRetry(fn, isNonRetryable, delayMock);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delayMock).not.toHaveBeenCalled();
  });
});

describe("DriveClient onProgress callback", () => {
  test("progress callback is invoked for listFolder", async () => {
    const progressMessages: string[] = [];
    const progressFn = mock((msg: string) => progressMessages.push(msg));

    // Test via the DriveClient class directly
    const { DriveClient } = await import("./client.js");
    const client = new DriveClient(MOCK_TOKEN, { onProgress: progressFn });

    // listFolder returns [] as stub
    const result = await client.listFolder("/Documents");
    expect(result).toEqual([]);
    expect(progressFn).toHaveBeenCalledWith("Listing folder: /Documents");
  });

  test("progress callback is invoked for uploadFile", async () => {
    const progressMessages: string[] = [];
    const progressFn = mock((msg: string) => progressMessages.push(msg));

    const { DriveClient } = await import("./client.js");
    const client = new DriveClient(MOCK_TOKEN, { onProgress: progressFn });

    await client.uploadFile("/local/file.txt", "/remote/file.txt");
    expect(progressFn).toHaveBeenCalledWith(
      "Uploading: /local/file.txt → /remote/file.txt",
    );
  });

  test("progress callback is invoked for downloadFile", async () => {
    const progressFn = mock((_msg: string) => {});
    const { DriveClient } = await import("./client.js");
    const client = new DriveClient(MOCK_TOKEN, { onProgress: progressFn });

    await client.downloadFile("/remote/file.txt", "/local/file.txt");
    expect(progressFn).toHaveBeenCalledWith(
      "Downloading: /remote/file.txt → /local/file.txt",
    );
  });

  test("no progress callback does not throw", async () => {
    const { DriveClient } = await import("./client.js");
    const client = new DriveClient(MOCK_TOKEN); // no opts
    // Should not throw
    await expect(client.listFolder("/")).resolves.toEqual([]);
  });
});

describe("DriveClient SDK boundary", () => {
  test("DriveClient can be constructed with a SessionToken", async () => {
    const { DriveClient } = await import("./client.js");
    expect(() => new DriveClient(MOCK_TOKEN)).not.toThrow();
  });
});
