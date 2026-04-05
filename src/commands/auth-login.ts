import type { Command } from "commander";
import * as readline from "readline";
import { authenticate, verifyTotp } from "../auth/srp.js";
import { createCredentialStore } from "../auth/credentials.js";
import { formatSuccess, formatError } from "../core/output.js";
import { AuthError, ConfigError, TwoFactorRequiredError } from "../errors.js";

async function promptUsername(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question("Username: ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function promptPassword(): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stdout.write("Password: ");

    type RawStdin = NodeJS.ReadStream & { _handle?: { setRawMode?: (v: boolean) => void } };
    const setRawMode = (on: boolean) => {
      if (process.stdin.isTTY) {
        (process.stdin as RawStdin)._handle?.setRawMode?.(on);
      }
    };

    setRawMode(true);

    let password = "";
    process.stdin.setEncoding("utf8");

    const cleanup = (restoreRaw: boolean) => {
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.removeListener("error", onError);
      process.stdin.pause();
      if (restoreRaw) setRawMode(false);
    };

    const onData = (ch: string) => {
      if (ch === "\n" || ch === "\r" || ch === "\u0004") {
        process.stdout.write("\n");
        cleanup(true);
        resolve(password);
      } else if (ch === "\u0003") {
        cleanup(true);
        process.exit(1);
      } else {
        password += ch;
      }
    };

    const onEnd = () => {
      cleanup(false);
      reject(new Error("stdin closed before password was entered"));
    };

    const onError = (err: Error) => {
      cleanup(false);
      reject(err);
    };

    process.stdin.resume();
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onError);
  });
}

async function promptTotp(): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stdout.write("2FA code: ");

    let code = "";
    process.stdin.setEncoding("utf8");

    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.removeListener("error", onError);
      process.stdin.pause();
    };

    const onData = (ch: string) => {
      for (const char of ch) {
        if (char === "\n" || char === "\r" || char === "\u0004") {
          process.stdout.write("\n");
          cleanup();
          resolve(code);
          return;
        } else if (char === "\u0003") {
          cleanup();
          process.exit(1);
        } else {
          code += char;
        }
      }
    };

    const onEnd = () => {
      cleanup();
      reject(new Error("stdin closed before TOTP code was entered"));
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    process.stdin.resume();
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onError);
  });
}

export function register(program: Command): void {
  program
    .command("login")
    .description("Authenticate with ProtonDrive")
    .action(async () => {
      const opts = program.parent?.opts() as { json?: boolean } | undefined;
      const json = opts?.json ?? false;
      try {
        const username = await promptUsername();
        const password = await promptPassword();
        const token = await authenticate(username, password).catch(async (err) => {
          if (!(err instanceof TwoFactorRequiredError)) throw err;
          if (!process.stdin.isTTY) {
            throw new AuthError(
              "2FA required but no TTY available — run 'protondrive auth login' interactively first.",
              "TOTP_NO_TTY",
            );
          }
          const totpCode = await promptTotp().catch((e: unknown) => {
            throw new AuthError(e instanceof Error ? e.message : String(e), "TOTP_IO_ERROR");
          });
          if (!/^\d{6}$/.test(totpCode)) {
            throw new AuthError("TOTP code must be 6 digits.", "TOTP_INVALID_FORMAT");
          }
          return verifyTotp(err.challenge, totpCode);
        });
        const credStore = createCredentialStore();
        await credStore.set("session", token.accessToken);
        // Token MUST NOT appear in output
        if (json) {
          formatSuccess({}, { json });
        } else {
          process.stdout.write("Logged in successfully.\n");
        }
      } catch (err) {
        formatError(err, { json });
        process.exit(err instanceof ConfigError ? 2 : 1);
      }
    });
}
