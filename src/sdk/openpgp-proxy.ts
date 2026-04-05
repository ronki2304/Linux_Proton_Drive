/**
 * OpenPGPCryptoProxy implementation backed by the `openpgp` v6 library.
 *
 * This file is used ONLY within src/sdk/ — it's part of the SDK boundary.
 * The interface it implements (OpenPGPCryptoProxy) is consumed by
 * OpenPGPCryptoWithCryptoProxy from @protontech/drive-sdk to produce the
 * OpenPGPCrypto instance that the SDK needs.
 *
 * Type casts (as unknown as T) are used in several places because:
 * 1. openpgp v6 uses Uint8Array<ArrayBufferLike> while SDK expects Uint8Array<ArrayBuffer>
 * 2. openpgp's PrivateKey/PublicKey classes satisfy SDK's PrivateKey/PublicKey interfaces
 *    at runtime, since _idx/_keyContentHash are TypeScript-only phantom types
 * 3. openpgp overloads require exact types we don't have
 */

import * as openpgp from "openpgp";
import type { OpenPGPCryptoProxy } from "@protontech/drive-sdk";
// Internal SDK crypto types — needed to implement OpenPGPCryptoProxy
import type { PrivateKey, PublicKey, SessionKey } from "@protontech/drive-sdk/dist/crypto/interface.js";
import { VERIFICATION_STATUS } from "@protontech/drive-sdk/dist/crypto/interface.js";

type AnyKey = unknown;

function toPgpPrivateKey(k: AnyKey): openpgp.PrivateKey {
  return k as openpgp.PrivateKey;
}
function toPgpPublicKey(k: AnyKey): openpgp.PublicKey {
  return k as openpgp.PublicKey;
}
function toSdkPrivateKey(k: openpgp.PrivateKey): PrivateKey {
  return k as unknown as PrivateKey;
}
function toSdkSessionKey(data: Uint8Array, algorithm: string | null, aeadAlgorithm?: string | null): SessionKey {
  return { data: data as unknown as Uint8Array<ArrayBuffer>, algorithm: algorithm ?? null, aeadAlgorithm: aeadAlgorithm ?? null };
}
function fromSdkSessionKey(sk: SessionKey): openpgp.SessionKey {
  return { data: sk.data as unknown as Uint8Array, algorithm: sk.algorithm as openpgp.enums.symmetricNames };
}

export const openPGPCryptoProxy: OpenPGPCryptoProxy = {
  async generateKey(options) {
    const { privateKey } = await openpgp.generateKey({
      type: "ecc",
      curve: "ed25519Legacy",
      userIDs: options.userIDs,
      format: "object",
      config: options.config?.aeadProtect ? { aeadProtect: true } : undefined,
    });
    return toSdkPrivateKey(privateKey);
  },

  async exportPrivateKey(options) {
    const pgpKey = toPgpPrivateKey(options.privateKey);
    if (options.passphrase) {
      const encrypted = await openpgp.encryptKey({ privateKey: pgpKey, passphrase: options.passphrase });
      return encrypted.armor();
    }
    return pgpKey.armor();
  },

  async importPrivateKey(options) {
    const pgpKey = await openpgp.readPrivateKey({ armoredKey: options.armoredKey });
    if (options.passphrase) {
      const decrypted = await openpgp.decryptKey({ privateKey: pgpKey, passphrase: options.passphrase });
      return toSdkPrivateKey(decrypted);
    }
    return toSdkPrivateKey(pgpKey);
  },

  async generateSessionKey(options) {
    const recipientKeys = options.recipientKeys.map(toPgpPublicKey);
    const sk = await openpgp.generateSessionKey({ encryptionKeys: recipientKeys });
    return toSdkSessionKey(sk.data, sk.algorithm, sk.aeadAlgorithm);
  },

  async encryptSessionKey(options) {
    const sk = fromSdkSessionKey(options);
    const encryptionKeys = options.encryptionKeys
      ? (Array.isArray(options.encryptionKeys)
        ? options.encryptionKeys.map(toPgpPublicKey)
        : [toPgpPublicKey(options.encryptionKeys)])
      : undefined;
    const result = await openpgp.encryptSessionKey({
      ...sk,
      encryptionKeys,
      passwords: options.passwords,
      format: "binary",
    });
    return result as unknown as Uint8Array<ArrayBuffer>;
  },

  async decryptSessionKey(options) {
    let message: openpgp.Message<Uint8Array | string>;
    if (options.binaryMessage) {
      message = await openpgp.readMessage({ binaryMessage: options.binaryMessage as Uint8Array });
    } else if (options.armoredMessage) {
      message = await openpgp.readMessage({ armoredMessage: options.armoredMessage });
    } else {
      return undefined;
    }
    const decryptionKeys = (Array.isArray(options.decryptionKeys)
      ? options.decryptionKeys.map(toPgpPrivateKey)
      : [toPgpPrivateKey(options.decryptionKeys)]);
    const sessionKeys = await openpgp.decryptSessionKeys({ message: message as openpgp.Message<Uint8Array>, decryptionKeys });
    const first = sessionKeys[0];
    if (!first) return undefined;
    return toSdkSessionKey(first.data, first.algorithm as string | null);
  },

  async encryptMessage(options) {
    const message = await openpgp.createMessage({ binary: options.binaryData as Uint8Array });
    const encryptionKeys = options.encryptionKeys.map(toPgpPublicKey);
    const signingKeys = options.signingKeys ? toPgpPrivateKey(options.signingKeys) : undefined;
    const sessionKey = options.sessionKey ? fromSdkSessionKey(options.sessionKey) : undefined;

    const encryptFn = openpgp.encrypt as (opts: unknown) => Promise<unknown>;
    const result = await encryptFn({
      message,
      encryptionKeys,
      signingKeys,
      sessionKey,
      format: options.format ?? "armored",
    });

    if (options.detached) {
      return { message: (result as unknown as { message: unknown }).message ?? result, signature: (result as unknown as { signature: unknown }).signature } as never;
    }
    return { message: result } as never;
  },

  async decryptMessage(options) {
    let message: openpgp.Message<Uint8Array | string>;
    if (options.binaryMessage) {
      message = await openpgp.readMessage({ binaryMessage: options.binaryMessage as Uint8Array });
    } else {
      message = await openpgp.readMessage({ armoredMessage: options.armoredMessage! });
    }

    let signature: openpgp.Signature | undefined;
    if (options.binarySignature) {
      signature = await openpgp.readSignature({ binarySignature: options.binarySignature as Uint8Array });
    } else if (options.armoredSignature) {
      signature = await openpgp.readSignature({ armoredSignature: options.armoredSignature });
    }

    const decryptionKeys = options.decryptionKeys
      ? (Array.isArray(options.decryptionKeys)
        ? options.decryptionKeys.map(toPgpPrivateKey)
        : [toPgpPrivateKey(options.decryptionKeys)])
      : undefined;
    const verificationKeys = options.verificationKeys
      ? (Array.isArray(options.verificationKeys)
        ? options.verificationKeys.map(toPgpPublicKey)
        : [toPgpPublicKey(options.verificationKeys)])
      : undefined;
    const sessionKeys = options.sessionKeys ? fromSdkSessionKey(options.sessionKeys) : undefined;

    const result = await openpgp.decrypt({
      message: message as openpgp.Message<Uint8Array>,
      signature,
      decryptionKeys,
      verificationKeys,
      sessionKeys: sessionKeys ? [sessionKeys] : undefined,
      format: (options.format ?? "utf8") as "binary",
    });

    let verificationStatus = VERIFICATION_STATUS.NOT_SIGNED;
    const verificationErrors: Error[] = [];
    for (const sig of result.signatures) {
      try {
        await sig.verified;
        verificationStatus = VERIFICATION_STATUS.SIGNED_AND_VALID;
      } catch (err) {
        verificationStatus = VERIFICATION_STATUS.SIGNED_AND_INVALID;
        if (err instanceof Error) verificationErrors.push(err);
      }
    }

    return {
      data: result.data as unknown as (string & Uint8Array<ArrayBuffer>),
      verificationStatus,
      verificationErrors: verificationErrors.length > 0 ? verificationErrors : undefined,
    };
  },

  async signMessage(options) {
    const message = await openpgp.createMessage({ binary: options.binaryData as Uint8Array });
    const signingKeys = (Array.isArray(options.signingKeys)
      ? options.signingKeys.map(toPgpPrivateKey)
      : [toPgpPrivateKey(options.signingKeys)]);
    const signFn = openpgp.sign as (opts: unknown) => Promise<unknown>;
    const result = await signFn({
      message,
      signingKeys,
      detached: options.detached,
      format: options.format,
    });
    return result as unknown as (string & Uint8Array<ArrayBuffer>);
  },

  async verifyMessage(options) {
    const message = await openpgp.createMessage({ binary: options.binaryData as Uint8Array });
    const verificationKeys = (Array.isArray(options.verificationKeys)
      ? options.verificationKeys.map(toPgpPublicKey)
      : [toPgpPublicKey(options.verificationKeys)]);

    let signature: openpgp.Signature;
    if (options.binarySignature) {
      signature = await openpgp.readSignature({ binarySignature: options.binarySignature as Uint8Array });
    } else {
      signature = await openpgp.readSignature({ armoredSignature: options.armoredSignature! });
    }

    const result = await openpgp.verify({
      message,
      signature,
      verificationKeys,
    });

    const errors: Error[] = [];
    let status = VERIFICATION_STATUS.NOT_SIGNED;
    for (const sig of result.signatures) {
      try {
        await sig.verified;
        status = VERIFICATION_STATUS.SIGNED_AND_VALID;
      } catch (err) {
        status = VERIFICATION_STATUS.SIGNED_AND_INVALID;
        if (err instanceof Error) errors.push(err);
      }
    }

    return {
      verificationStatus: status,
      errors: errors.length > 0 ? errors : undefined,
    };
  },
};
