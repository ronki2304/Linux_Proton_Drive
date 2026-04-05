// This is the ONLY file in the codebase that imports @napi-rs/keyring
import { Entry } from "@napi-rs/keyring";
import type { CredentialStore } from "./credentials.js";

const SERVICE = "protondrive";

export class KeyringStore implements CredentialStore {
  // Throws if no keychain daemon is available (caught by createCredentialStore)
  probe(): void {
    // Attempting a get on a non-existent key forces the runtime to connect to
    // the keychain daemon. Throws if the daemon is unavailable.
    new Entry(SERVICE, "__probe__").getPassword();
  }

  async get(key: string): Promise<string | null> {
    try {
      const entry = new Entry(SERVICE, key);
      return entry.getPassword() ?? null;
    } catch {
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    const entry = new Entry(SERVICE, key);
    entry.setPassword(value);
  }

  async delete(key: string): Promise<void> {
    try {
      const entry = new Entry(SERVICE, key);
      entry.deletePassword();
    } catch {
      // Ignore if key doesn't exist
    }
  }
}
