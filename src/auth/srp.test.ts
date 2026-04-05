import { describe, test, expect, mock, afterEach } from "bun:test";
import { authenticate, verifyTotp } from "./srp.js";
import { AuthError, NetworkError, TwoFactorRequiredError } from "../errors.js";
import type { SessionToken } from "../types.js";

// Valid-looking auth info response (server ephemeral is 256 bytes, salt is 16 bytes, base64)
const MOCK_INFO_RESPONSE = {
  Code: 1000,
  ServerEphemeral: Buffer.alloc(256, 0x42).toString("base64"),
  Salt: Buffer.alloc(16, 0xab).toString("base64"),
  Modulus: "mock-modulus",
  SRPSession: "mock-srp-session-id",
  Version: 4,
};

const MOCK_TOKEN_RESPONSE = {
  Code: 1000,
  AccessToken: "mock-access-token",
  RefreshToken: "mock-refresh-token",
  UID: "mock-uid",
};

const MOCK_2FA_CODE_RESPONSE = {
  Code: 9001,
};

const MOCK_2FA_FIELD_RESPONSE = {
  Code: 1000,
  AccessToken: "tok",
  RefreshToken: "ref",
  UID: "uid",
  TwoFactor: { Enabled: 1 },
};

const MOCK_AUTH_FAILED_RESPONSE = {
  Code: 8002,
};

const originalFetch = globalThis.fetch;

function mockFetch(...responses: object[]) {
  let callIdx = 0;
  const fetchMock = mock((_url: string, _opts: unknown) => {
    const body = responses[callIdx++] ?? responses[responses.length - 1];
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("authenticate — 2FA handling", () => {
  test("Code 9001 (no tokens) throws AuthError with TWO_FACTOR_REQUIRED", async () => {
    mockFetch(MOCK_INFO_RESPONSE, MOCK_2FA_CODE_RESPONSE);
    let thrown: unknown;
    try {
      await authenticate("user@proton.me", "password");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AuthError);
    expect(thrown).not.toBeInstanceOf(TwoFactorRequiredError);
    expect((thrown as AuthError).code).toBe("TWO_FACTOR_REQUIRED");
    expect((thrown as AuthError).message).toBe(
      "2FA required — could not obtain partial session from Proton API.",
    );
  });

  test("TwoFactor field + tokens → throws TwoFactorRequiredError with challenge", async () => {
    mockFetch(MOCK_INFO_RESPONSE, MOCK_2FA_FIELD_RESPONSE);
    let thrown: unknown;
    try {
      await authenticate("user@proton.me", "password");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TwoFactorRequiredError);
    expect((thrown as TwoFactorRequiredError).code).toBe("TWO_FACTOR_REQUIRED");
    const challenge = (thrown as TwoFactorRequiredError).challenge;
    expect(challenge.accessToken).toBe("tok");
    expect(challenge.refreshToken).toBe("ref");
    expect(challenge.uid).toBe("uid");
  });
});

describe("verifyTotp", () => {
  const MOCK_CHALLENGE: SessionToken = {
    accessToken: "partial-access",
    refreshToken: "partial-refresh",
    uid: "partial-uid",
  };

  test("Code 1000 → returns same challenge as SessionToken (full scope)", async () => {
    mockFetch({ Code: 1000 });
    const result = await verifyTotp(MOCK_CHALLENGE, "123456");
    expect(result).toEqual(MOCK_CHALLENGE);
  });

  test("Code 8002 → throws AuthError with TOTP_INVALID", async () => {
    mockFetch({ Code: 8002 });
    let thrown: unknown;
    try {
      await verifyTotp(MOCK_CHALLENGE, "000000");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AuthError);
    expect((thrown as AuthError).code).toBe("TOTP_INVALID");
    expect((thrown as AuthError).message).toContain("Invalid 2FA code");
  });

  test("non-1000 code → throws AuthError with TOTP_INVALID", async () => {
    mockFetch({ Code: 9999 });
    let thrown: unknown;
    try {
      await verifyTotp(MOCK_CHALLENGE, "111111");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AuthError);
    expect((thrown as AuthError).code).toBe("TOTP_INVALID");
  });

  test("network failure → throws NetworkError", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("ECONNREFUSED")),
    ) as unknown as typeof fetch;
    let thrown: unknown;
    try {
      await verifyTotp(MOCK_CHALLENGE, "123456");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NetworkError);
    expect((thrown as NetworkError).message).toContain("Network request failed");
  });
});

describe("authenticate — credential failure", () => {
  test("Code 8002 throws AuthError with AUTH_FAILED code", async () => {
    mockFetch(MOCK_INFO_RESPONSE, MOCK_AUTH_FAILED_RESPONSE);
    let thrown: unknown;
    try {
      await authenticate("user@proton.me", "wrongpassword");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AuthError);
    expect((thrown as AuthError).code).toBe("AUTH_FAILED");
    expect((thrown as AuthError).message).toContain("Authentication failed");
  });

  test("missing AccessToken in success response throws AUTH_FAILED", async () => {
    mockFetch(MOCK_INFO_RESPONSE, { Code: 1000, RefreshToken: "r", UID: "u" });
    let thrown: unknown;
    try {
      await authenticate("user@proton.me", "password");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AuthError);
    expect((thrown as AuthError).code).toBe("AUTH_FAILED");
  });
});

describe("authenticate — network failures", () => {
  test("fetch rejection throws NetworkError", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("ECONNREFUSED")),
    ) as unknown as typeof fetch;
    let thrown: unknown;
    try {
      await authenticate("user@proton.me", "password");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NetworkError);
    expect((thrown as NetworkError).message).toContain("Network request failed");
  });

  test("HTTP 500 throws NetworkError", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("{}", { status: 500 })),
    ) as unknown as typeof fetch;
    let thrown: unknown;
    try {
      await authenticate("user@proton.me", "password");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NetworkError);
  });
});

describe("authenticate — info validation", () => {
  test("missing Salt throws AuthError with AUTH_INFO_INVALID", async () => {
    mockFetch({ ...MOCK_INFO_RESPONSE, Salt: "" }, MOCK_TOKEN_RESPONSE);
    let thrown: unknown;
    try {
      await authenticate("user@proton.me", "password");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AuthError);
    expect((thrown as AuthError).code).toBe("AUTH_INFO_INVALID");
  });

  test("missing SRPSession throws AuthError with AUTH_INFO_INVALID", async () => {
    mockFetch({ ...MOCK_INFO_RESPONSE, SRPSession: "" }, MOCK_TOKEN_RESPONSE);
    let thrown: unknown;
    try {
      await authenticate("user@proton.me", "password");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AuthError);
    expect((thrown as AuthError).code).toBe("AUTH_INFO_INVALID");
  });

  test("non-numeric Version throws AuthError with AUTH_INFO_INVALID", async () => {
    mockFetch({ ...MOCK_INFO_RESPONSE, Version: "bad" as unknown as number }, MOCK_TOKEN_RESPONSE);
    let thrown: unknown;
    try {
      await authenticate("user@proton.me", "password");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AuthError);
    expect((thrown as AuthError).code).toBe("AUTH_INFO_INVALID");
  });

  test("version < 3 throws AuthError with UNSUPPORTED_VERSION", async () => {
    mockFetch({ ...MOCK_INFO_RESPONSE, Version: 2 }, MOCK_TOKEN_RESPONSE);
    let thrown: unknown;
    try {
      await authenticate("user@proton.me", "password");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AuthError);
    expect((thrown as AuthError).code).toBe("UNSUPPORTED_VERSION");
    expect((thrown as AuthError).message).toContain("not supported");
  });
});

describe("authenticate — server proof verification", () => {
  test("invalid ServerProof throws AuthError with SRP_INVALID_SERVER_PROOF", async () => {
    mockFetch(MOCK_INFO_RESPONSE, {
      ...MOCK_TOKEN_RESPONSE,
      ServerProof: Buffer.alloc(32, 0xff).toString("base64"), // wrong proof
    });
    let thrown: unknown;
    try {
      await authenticate("user@proton.me", "password");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AuthError);
    expect((thrown as AuthError).code).toBe("SRP_INVALID_SERVER_PROOF");
  });

  test("absent ServerProof does not throw (verification skipped)", async () => {
    mockFetch(MOCK_INFO_RESPONSE, MOCK_TOKEN_RESPONSE);
    // Should NOT throw — ServerProof is absent, verification is skipped
    const token = await authenticate("user@proton.me", "password");
    expect(token.accessToken).toBe("mock-access-token");
  });
});

describe("authenticate — success case (mocked)", () => {
  test("returns SessionToken with correct shape", async () => {
    mockFetch(MOCK_INFO_RESPONSE, MOCK_TOKEN_RESPONSE);
    const token = await authenticate("user@proton.me", "password");
    expect(token.accessToken).toBe("mock-access-token");
    expect(token.refreshToken).toBe("mock-refresh-token");
    expect(token.uid).toBe("mock-uid");
  });

  test("SessionToken fields are all non-empty strings", async () => {
    mockFetch(MOCK_INFO_RESPONSE, MOCK_TOKEN_RESPONSE);
    const token = await authenticate("user@proton.me", "password");
    expect(typeof token.accessToken).toBe("string");
    expect(token.accessToken.length).toBeGreaterThan(0);
    expect(typeof token.refreshToken).toBe("string");
    expect(token.refreshToken.length).toBeGreaterThan(0);
    expect(typeof token.uid).toBe("string");
    expect(token.uid.length).toBeGreaterThan(0);
  });
});
