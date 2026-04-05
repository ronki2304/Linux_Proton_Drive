import type { Command } from "commander";
import { createCredentialStore } from "../auth/credentials.js";
import { formatSuccess, formatError } from "../core/output.js";
import { ConfigError } from "../errors.js";

export function register(program: Command): void {
  program
    .command("logout")
    .description("Remove stored credentials")
    .action(async () => {
      const opts = program.parent?.opts() as { json?: boolean } | undefined;
      const json = opts?.json ?? false;
      try {
        const credStore = createCredentialStore();
        const existing = await credStore.get("session");
        if (!existing) {
          formatSuccess("No active session.", { json });
          return;
        }
        await credStore.delete("session");
        formatSuccess("Logged out successfully.", { json });
      } catch (err) {
        formatError(err, { json });
        process.exit(err instanceof ConfigError ? 2 : 1);
      }
    });
}
