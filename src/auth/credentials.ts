import { KeyringStore } from "./keyring-store.js";
import { FileStore } from "./file-store.js";
import { AuthError } from "../errors.js";

export interface CredentialStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export function createCredentialStore(): CredentialStore {
  try {
    const store = new KeyringStore();
    // Probe to verify keychain is accessible
    store.probe();
    return store;
  } catch {
    return new FileStore();
  }
}

export async function getSessionToken(
  store?: CredentialStore,
): Promise<string> {
  const credStore = store ?? createCredentialStore();
  const token = await credStore.get("session");
  if (!token) {
    throw new AuthError(
      "No session found — run 'protondrive auth login' first.",
      "NO_SESSION",
    );
  }
  return token;
}
