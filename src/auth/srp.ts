/**
 * Proton SRP-B Authentication
 *
 * Implements Proton's custom SRP-6a variant for authentication.
 * Reference: henrybear327/Proton-API-Bridge (Go), rclone Proton SRP port
 *
 * Flow:
 *   1. POST /auth/v4/info — get ServerEphemeral, Salt, SRPSession, Version
 *   2. Hash password with bcrypt (v4) using server-provided salt
 *   3. Compute SRP client proof using 2048-bit RFC5054 group
 *   4. POST /auth/v4 — exchange proof for AccessToken/RefreshToken/UID
 *
 * Security invariants:
 *   - accessToken, refreshToken, clientProof, hashedPassword NEVER logged
 *   - SRP intermediate values (clientEphemeral, x, K) never exposed
 */

import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { AuthError, HumanVerificationRequiredError, NetworkError, TwoFactorRequiredError } from "../errors.js";
import type { SessionToken } from "../types.js";

const PROTON_API = "https://mail.proton.me/api";

// SRP 2048-bit group (RFC 5054 §A.1)
const N_HEX =
  "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AACAA68FFFFFFFFFFFFFFFF";
const N_BUF = Buffer.from(N_HEX, "hex");
const N = BigInt("0x" + N_HEX);
const g = 2n;
const SRP_LEN = 256; // 2048 bits / 8

// Proton auth API error codes
const CODE_HUMAN_VERIFICATION = 9001; // CAPTCHA required — triggered by bot detection
const CODE_AUTH_FAILED = 8002;

interface AuthInfoResponse {
  Code: number;
  ServerEphemeral: string;
  Salt: string;
  Modulus: string;
  SRPSession: string;
  Version: number;
  Details?: { WebUrl?: string; HumanVerificationToken?: string };
}

interface AuthResponse {
  Code: number;
  AccessToken?: string;
  RefreshToken?: string;
  UID?: string;
  TwoFactor?: { Enabled: number; TOTP?: number } | Record<string, unknown>;
  ServerProof?: string;
  Details?: { WebUrl?: string; HumanVerificationToken?: string };
}

// --- BigInt helpers ---

function bigIntToBuffer(n: bigint, length: number): Buffer {
  const hex = n.toString(16).padStart(length * 2, "0");
  return Buffer.from(hex, "hex");
}

function bufferToBigInt(buf: Buffer): bigint {
  return BigInt("0x" + buf.toString("hex"));
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = ((base % mod) + mod) % mod;
  let e = exp;
  while (e > 0n) {
    if (e % 2n === 1n) result = (result * b) % mod;
    e = e >> 1n;
    b = (b * b) % mod;
  }
  return result;
}

// --- Hash helpers ---

function sha256(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest() as Buffer;
}

function sha256Xor(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) {
    out[i] = (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return out;
}

// --- Proton password expansion (v4) ---

function expandPassword(password: string): string {
  // Pad UTF-8 bytes to 64 bytes with null bytes, then base64-encode
  const passwordBytes = Buffer.from(password, "utf8");
  const padded = Buffer.alloc(64, 0);
  passwordBytes.copy(padded, 0, 0, Math.min(passwordBytes.length, 64));
  return padded.toString("base64");
}

// Proton bcrypt salt: server may return fewer than 16 bytes; bcrypt requires exactly 16.
// Pad with zeros and encode using bcryptjs's own encodeBase64 to guarantee exactly 22 chars.
function formatBcryptSalt(saltBytes: Buffer): string {
  const padded = Buffer.alloc(16, 0);
  saltBytes.copy(padded, 0, 0, Math.min(saltBytes.length, 16));
  return "$2y$10$" + bcrypt.encodeBase64(padded, 16);
}

function hashPassword(password: string, saltBytes: Buffer, version: number): string {
  if (version >= 3) {
    const expanded = expandPassword(password);
    const bcryptSalt = formatBcryptSalt(saltBytes);
    return bcrypt.hashSync(expanded, bcryptSalt);
  }
  throw new AuthError(
    `Password version ${version} is not supported — contact Proton support or upgrade your account.`,
    "UNSUPPORTED_VERSION",
  );
}

// --- SRP-6a computation ---

function computeK(): bigint {
  const gBuf = bigIntToBuffer(g, SRP_LEN);
  const hash = sha256(Buffer.concat([N_BUF, gBuf]));
  return bufferToBigInt(hash);
}

function computeX(username: string, hashedPassword: string, saltBytes: Buffer): bigint {
  const inner = sha256(
    Buffer.from(username.toLowerCase() + ":" + hashedPassword, "utf8"),
  );
  const hash = sha256(Buffer.concat([saltBytes, inner]));
  return bufferToBigInt(hash);
}

function computeU(A: Buffer, B: Buffer): bigint {
  return bufferToBigInt(sha256(Buffer.concat([A, B])));
}

function computeClientProof(
  username: string,
  saltBytes: Buffer,
  A: Buffer,
  B: Buffer,
  K: Buffer,
): Buffer {
  const gBuf = bigIntToBuffer(g, SRP_LEN);
  const HN = sha256(N_BUF);
  const Hg = sha256(gBuf);
  const HNxorHg = sha256Xor(HN, Hg);
  const HI = sha256(Buffer.from(username.toLowerCase(), "utf8"));
  return sha256(
    Buffer.concat([HNxorHg, HI, saltBytes, A, B, K]),
  );
}

const FETCH_MAX_ATTEMPTS = 3;
const FETCH_RETRY_DELAYS_MS = [500, 1500] as const;

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function fetchJson<T>(
  url: string,
  options: RequestInit,
): Promise<T> {
  let lastError: NetworkError | null = null;
  for (let attempt = 0; attempt < FETCH_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise<void>((r) => setTimeout(r, FETCH_RETRY_DELAYS_MS[attempt - 1] ?? 1500));
    }
    let response: Response;
    try {
      response = await fetch(url, options);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastError = new NetworkError(`Network request failed: ${msg}`, "NETWORK_FETCH_FAILED");
      continue;
    }
    if (!response.ok && response.status !== 422) {
      let body = "";
      try { body = await response.text(); } catch { /* ignore */ }
      const detail = body ? ` — ${body.slice(0, 300)}` : "";
      const error = new NetworkError(
        `HTTP ${response.status} from Proton API${detail}`,
        "NETWORK_HTTP_ERROR",
      );
      if (!isRetryableStatus(response.status)) {
        throw error;
      }
      lastError = error;
      continue;
    }
    try {
      return await (response.json() as Promise<T>);
    } catch {
      throw new NetworkError("Response body is not valid JSON", "NETWORK_PARSE_ERROR");
    }
  }
  throw lastError ?? new NetworkError("All retry attempts exhausted", "NETWORK_FETCH_FAILED");
}

// --- SRP proof builder (for SRPModule) ---

export async function buildSRPProof(
  version: number,
  serverEphemeral: string,
  salt: string,
  password: string,
): Promise<{ clientProof: string; clientEphemeral: string; expectedServerProof: string }> {
  const saltBytes = Buffer.from(salt, "base64");
  const B = Buffer.from(serverEphemeral, "base64");
  const hashedPassword = hashPassword(password, saltBytes, version);

  const aBytes = randomBytes(SRP_LEN);
  const a = bufferToBigInt(aBytes);
  const Abig = modPow(g, a, N);
  const A = bigIntToBuffer(Abig, SRP_LEN);
  const Bint = bufferToBigInt(B);
  const k = computeK();
  const x = computeX("", hashedPassword, saltBytes);
  const u = computeU(A, B);
  const gx = modPow(g, x, N);
  const kgx = (k * gx) % N;
  const diff = ((Bint - kgx) % N + N) % N;
  const exp = (a + u * x) % (N - 1n);
  const Sbig = modPow(diff, exp, N);
  const Sbuf = bigIntToBuffer(Sbig, SRP_LEN);
  const K = sha256(Sbuf);
  const M1 = computeClientProof("", saltBytes, A, B, K);
  const M2 = sha256(Buffer.concat([A, M1, K]));
  return {
    clientProof: M1.toString("base64"),
    clientEphemeral: A.toString("base64"),
    expectedServerProof: M2.toString("base64"),
  };
}

/** Derives the ProtonDrive mailbox key password from the user's password and key salt. */
export function deriveKeyPassword(password: string, keySaltBase64: string): string {
  const saltBytes = Buffer.from(keySaltBase64, "base64");
  return hashPassword(password, saltBytes, 4);
}

// --- Public API ---

export async function authenticate(
  username: string,
  password: string,
  opts?: { humanVerificationToken?: string; humanVerificationTokenType?: string },
): Promise<SessionToken> {
  const captchaHeaders: Record<string, string> = {};
  if (opts?.humanVerificationToken) {
    captchaHeaders["x-pm-human-verification-token"] = opts.humanVerificationToken;
    captchaHeaders["x-pm-human-verification-token-type"] = opts.humanVerificationTokenType ?? "captcha";
  }

  // Step 1: Get auth info
  const info = await fetchJson<AuthInfoResponse>(
    `${PROTON_API}/auth/v4/info`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-pm-appversion": "macos-drive@1.0.0-alpha.1+rclone", ...captchaHeaders },
      body: JSON.stringify({ Username: username }),
    },
  );

  if (info.Code === CODE_HUMAN_VERIFICATION) {
    const webUrl = info.Details?.WebUrl;
    const token = info.Details?.HumanVerificationToken;
    if (!webUrl || !token) {
      throw new AuthError(
        "Human verification required but Proton did not provide a verification URL. Please try again later.",
        "HUMAN_VERIFICATION_REQUIRED",
      );
    }
    throw new HumanVerificationRequiredError(webUrl, token);
  }

  if (!info.Salt || !info.ServerEphemeral || !info.SRPSession) {
    throw new AuthError("Malformed auth info response from Proton API", "AUTH_INFO_INVALID");
  }
  if (typeof info.Version !== "number") {
    throw new AuthError("Missing or invalid password version in auth info", "AUTH_INFO_INVALID");
  }

  const saltBytes = Buffer.from(info.Salt, "base64");
  const serverEphemeral = Buffer.from(info.ServerEphemeral, "base64");

  // Hash password using server-specified version
  const hashedPassword = hashPassword(password, saltBytes, info.Version);

  // Step 2: Generate client ephemeral A
  const aBytes = randomBytes(SRP_LEN);
  const a = bufferToBigInt(aBytes);
  const Abig = modPow(g, a, N);
  if (Abig % N === 0n) {
    throw new AuthError("Generated client ephemeral is zero mod N — retry authentication", "SRP_ERROR");
  }
  const A = bigIntToBuffer(Abig, SRP_LEN);

  const B = serverEphemeral;
  const Bint = bufferToBigInt(B);
  if (Bint % N === 0n) {
    throw new AuthError("Server ephemeral B is zero mod N — aborting authentication", "SRP_ERROR");
  }

  // Compute SRP session key S and K
  const k = computeK();
  const x = computeX(username, hashedPassword, saltBytes);
  const u = computeU(A, B);
  if (u === 0n) {
    throw new AuthError("SRP scrambling parameter u is zero — aborting authentication", "SRP_ERROR");
  }
  const gx = modPow(g, x, N);
  const kgx = (k * gx) % N;
  const diff = ((Bint - kgx) % N + N) % N;
  const exp = (a + u * x) % (N - 1n);
  const Sbig = modPow(diff, exp, N);
  const Sbuf = bigIntToBuffer(Sbig, SRP_LEN);
  const K = sha256(Sbuf);

  // Compute client proof M1
  const M1 = computeClientProof(username, saltBytes, A, B, K);

  // Step 3: Send proof
  // Note: captchaHeaders are intentionally NOT sent on the auth step — the HV token
  // is consumed by the info step; re-sending it causes Code 12087 (TOKEN_INVALID).
  const auth = await fetchJson<AuthResponse>(
    `${PROTON_API}/auth/v4`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-pm-appversion": "macos-drive@1.0.0-alpha.1+rclone" },
      body: JSON.stringify({
        Username: username,
        ClientEphemeral: A.toString("base64"),
        ClientProof: M1.toString("base64"),
        SRPSession: info.SRPSession,
        PersistentCookies: 0,
      }),
    },
  );

  // Human Verification (CAPTCHA) — Proton's bot detection fired before auth completed.
  if (auth.Code === CODE_HUMAN_VERIFICATION) {
    const webUrl = auth.Details?.WebUrl;
    const token = auth.Details?.HumanVerificationToken;
    if (!webUrl || !token) {
      throw new AuthError(
        "Human verification required but Proton did not provide a verification URL. Please try again later.",
        "HUMAN_VERIFICATION_REQUIRED",
      );
    }
    throw new HumanVerificationRequiredError(webUrl, token);
  }

  // Handle 2FA challenge — Code 1000 + TwoFactor field + partial scope tokens.
  if (auth.TwoFactor !== undefined) {
    if (auth.AccessToken && auth.RefreshToken && auth.UID) {
      throw new TwoFactorRequiredError({
        accessToken: auth.AccessToken,
        refreshToken: auth.RefreshToken,
        uid: auth.UID,
      });
    }
    throw new AuthError(
      "2FA required — could not obtain partial session from Proton API.",
      "TOTP_SESSION_INCOMPLETE",
    );
  }

  // Handle auth failure
  if (
    auth.Code === CODE_AUTH_FAILED ||
    !auth.AccessToken ||
    !auth.RefreshToken ||
    !auth.UID
  ) {
    throw new AuthError(
      `Authentication failed (Code ${auth.Code}) — check your username and password.`,
      "AUTH_FAILED",
    );
  }

  // Verify server proof M2 = SHA256(A || M1 || K) when provided (mutual authentication).
  // If present, an invalid proof indicates a potential MitM attack.
  // TODO: make required once integration tests confirm Proton always includes ServerProof.
  if (auth.ServerProof) {
    const expectedM2 = sha256(Buffer.concat([A, M1, K]));
    const serverM2 = Buffer.from(auth.ServerProof, "base64");
    if (!expectedM2.equals(serverM2)) {
      throw new AuthError(
        "Server proof verification failed — possible MitM attack",
        "SRP_INVALID_SERVER_PROOF",
      );
    }
  }

  return {
    accessToken: auth.AccessToken,
    refreshToken: auth.RefreshToken,
    uid: auth.UID,
  };
}

interface TwoFAResponse {
  Code: number;
}

export async function verifyTotp(
  challenge: SessionToken,
  totpCode: string,
): Promise<SessionToken> {
  const result = await fetchJson<TwoFAResponse>(
    `${PROTON_API}/auth/v4/2fa`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${challenge.accessToken}`,
        "x-pm-uid": challenge.uid,
        "x-pm-appversion": "macos-drive@1.0.0-alpha.1+rclone",
      },
      body: JSON.stringify({ TwoFactorCode: totpCode }),
    },
  );

  if (result.Code === 1000) {
    return challenge;
  }
  throw new AuthError(
    "Invalid 2FA code — check your authenticator app.",
    "TOTP_INVALID",
  );
}
