import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { CredentialStore } from "./credentials.js";

function getCredentialsDir(): string {
  const xdgDataHome =
    process.env["XDG_DATA_HOME"] ?? path.join(os.homedir(), ".local", "share");
  return path.join(xdgDataHome, "protondrive");
}

function validateKey(key: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
    throw new Error(`Invalid credential key: ${JSON.stringify(key)}`);
  }
}

function getCredentialsPath(key: string): string {
  return path.join(getCredentialsDir(), `credentials.${key}`);
}

export class FileStore implements CredentialStore {
  async get(key: string): Promise<string | null> {
    validateKey(key);
    const filePath = getCredentialsPath(key);
    try {
      return await Bun.file(filePath).text();
    } catch {
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    validateKey(key);
    const dir = getCredentialsDir();
    fs.mkdirSync(dir, { recursive: true });
    const filePath = getCredentialsPath(key);
    // writeFileSync used here (not Bun.write) to set 0600 permissions atomically
    fs.writeFileSync(filePath, value, { mode: 0o600 });
  }

  async delete(key: string): Promise<void> {
    validateKey(key);
    const filePath = getCredentialsPath(key);
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Ignore if file doesn't exist
    }
  }
}
