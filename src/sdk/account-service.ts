/**
 * ProtonDriveAccount implementation for CLI context.
 *
 * Fetches user addresses from the Proton API and decrypts private keys
 * using the user's mailbox key password.
 *
 * This file is part of the SDK boundary layer — only used within src/sdk/.
 */

import * as openpgp from "openpgp";
import type { ProtonDriveAccount, ProtonDriveAccountAddress } from "@protontech/drive-sdk";
import type { PrivateKey, PublicKey } from "@protontech/drive-sdk/dist/crypto/interface.js";
import type { ProtonDriveHTTPClient } from "@protontech/drive-sdk";
import { AuthError } from "../errors.js";
import { deriveKeyPassword } from "../auth/srp.js";

const PROTON_API = "https://api.proton.me";

// Cast openpgp keys to SDK types (safe — see openpgp-proxy.ts for rationale)
function toSdkPrivateKey(k: openpgp.PrivateKey): PrivateKey {
  return k as unknown as PrivateKey;
}
function toSdkPublicKey(k: openpgp.PublicKey): PublicKey {
  return k as unknown as PublicKey;
}

interface AddressKeyPayload {
  ID: string;
  PrivateKey: string;
  PublicKey?: string;
  Primary: number;
  Active: number;
}

interface AddressPayload {
  ID: string;
  Email: string;
  Order: number;
  Keys: AddressKeyPayload[];
}

interface AddressesResponse {
  Code: number;
  Addresses: AddressPayload[];
}

interface KeySaltPayload {
  ID: string;
  KeySalt: string | null;
}

interface KeySaltsResponse {
  Code: number;
  KeySalts: KeySaltPayload[];
}

async function callApi<T>(
  path: string,
  httpClient: ProtonDriveHTTPClient,
): Promise<T> {
  const response = await httpClient.fetchJson({
    url: `${PROTON_API}/${path}`,
    method: "GET",
    timeoutMs: 30_000,
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        "Session token expired or invalid — run 'protondrive auth login'.",
        "AUTH_TOKEN_EXPIRED",
      );
    }
    throw new Error(`Proton API error ${response.status} for ${path}`);
  }
  const data = await response.json() as { Code?: number } & T;
  if (data.Code !== undefined && data.Code !== 1000) {
    throw new Error(`Proton API returned error code ${data.Code} for ${path}`);
  }
  return data;
}

export async function buildAccount(
  password: string,
  httpClient: ProtonDriveHTTPClient,
): Promise<ProtonDriveAccount> {
  const [addressesResp, saltsResp] = await Promise.all([
    callApi<AddressesResponse>("core/v4/addresses", httpClient),
    callApi<KeySaltsResponse>("core/v4/keys/salts", httpClient),
  ]);

  const saltMap = new Map<string, string>();
  for (const s of saltsResp.KeySalts) {
    if (s.KeySalt) saltMap.set(s.ID, s.KeySalt);
  }

  const addresses: ProtonDriveAccountAddress[] = [];

  for (const addr of addressesResp.Addresses) {
    const decryptedKeys: { id: string; key: PrivateKey }[] = [];

    for (const k of addr.Keys) {
      if (!k.Active || !k.PrivateKey) continue;
      try {
        const pgpKey = await openpgp.readPrivateKey({ armoredKey: k.PrivateKey });
        const keySalt = saltMap.get(k.ID);
        let decryptedKey: openpgp.PrivateKey;
        if (keySalt) {
          const keyPassword = deriveKeyPassword(password, keySalt);
          decryptedKey = await openpgp.decryptKey({ privateKey: pgpKey, passphrase: keyPassword });
        } else {
          // Key has no salt — try decrypting without passphrase (unencrypted key)
          decryptedKey = pgpKey;
        }
        decryptedKeys.push({ id: k.ID, key: toSdkPrivateKey(decryptedKey) });
      } catch {
        // Skip keys that can't be decrypted (e.g. old migration keys)
      }
    }

    if (decryptedKeys.length === 0) continue;

    const primaryKeyId = addr.Keys.find((k) => k.Primary === 1 && !!k.Active)?.ID;
    const primaryIndex = primaryKeyId !== undefined
      ? decryptedKeys.findIndex(({ id }) => id === primaryKeyId)
      : 0;
    addresses.push({
      email: addr.Email,
      addressId: addr.ID,
      primaryKeyIndex: primaryIndex >= 0 ? primaryIndex : 0,
      keys: decryptedKeys,
    });
  }

  if (addressesResp.Addresses.length > 0 && addresses.length === 0) {
    throw new Error(
      "Failed to decrypt any ProtonDrive address keys — the password may be incorrect",
    );
  }

  return {
    async getOwnPrimaryAddress() {
      const primary = addresses.find((a) => a.keys.length > 0);
      if (!primary) throw new Error("No usable primary address found");
      return primary;
    },
    async getOwnAddresses() {
      return addresses;
    },
    async getOwnAddress(emailOrAddressId: string) {
      const found = addresses.find(
        (a) => a.email === emailOrAddressId || a.addressId === emailOrAddressId,
      );
      if (!found) throw new Error(`Address not found: ${emailOrAddressId}`);
      return found;
    },
    async hasProtonAccount(_email: string) {
      return true; // not used in file operations
    },
    async getPublicKeys(email: string): Promise<PublicKey[]> {
      const addr = addresses.find((a) => a.email === email);
      if (!addr) return [];
      // Return public parts of the decrypted keys
      return addr.keys.map(({ key }) => {
        const pgpKey = key as unknown as openpgp.PrivateKey;
        return toSdkPublicKey(pgpKey.toPublic());
      });
    },
  };
}
