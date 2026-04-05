import { describe, test, expect } from "bun:test";
import { FileStore } from "./file-store.js";
import type { CredentialStore } from "./credentials.js";

// Test the factory fallback behavior using a manual simulation
// (full factory test requires a real or mocked keychain daemon)

function createCredentialStoreWithFallback(
  tryKeyring: () => CredentialStore,
  fallback: () => CredentialStore,
): CredentialStore {
  try {
    const store = tryKeyring();
    return store;
  } catch {
    return fallback();
  }
}

describe("createCredentialStore — factory fallback logic", () => {
  test("returns keyring store when keyring probe succeeds", () => {
    let keyringSideEffect = false;
    const store = createCredentialStoreWithFallback(
      () => {
        keyringSideEffect = true;
        return new FileStore(); // use FileStore as a stand-in for a working keyring
      },
      () => new FileStore(),
    );
    expect(keyringSideEffect).toBe(true);
    expect(store).toBeDefined();
  });

  test("falls back to FileStore when keyring probe throws", () => {
    const fallback = new FileStore();
    const store = createCredentialStoreWithFallback(
      () => {
        throw new Error("No keychain daemon available");
      },
      () => fallback,
    );
    expect(store).toBe(fallback);
  });

  test("fallback store satisfies CredentialStore interface", () => {
    const store = createCredentialStoreWithFallback(
      () => {
        throw new Error("no daemon");
      },
      () => new FileStore(),
    );
    expect(typeof store.get).toBe("function");
    expect(typeof store.set).toBe("function");
    expect(typeof store.delete).toBe("function");
  });
});
