import type { Command } from "commander";
import { getSessionToken } from "../auth/credentials.js";
import { DriveClient } from "../sdk/client.js";
import { loadConfig } from "../core/config.js";
import { StateDB } from "../core/state-db.js";
import { SyncEngine } from "../core/sync-engine.js";
import { formatSuccess, formatError, makeProgressCallback } from "../core/output.js";
import { ConfigError } from "../errors.js";
import type { ConflictRecord } from "../types.js";

export function register(program: Command): void {
  program
    .command("sync")
    .description("Two-way sync all configured local/remote pairs")
    .action(async () => {
      const opts = program.opts() as { json?: boolean; config?: string };
      const json = opts.json ?? false;
      const onProgress = makeProgressCallback("sync", { json });

      let stateDb: StateDB | undefined;
      try {
        // Config-first, fail-fast (NFR13) — before any network call
        const config = await loadConfig(opts.config);
        const token = await getSessionToken();

        const client = new DriveClient(token, { onProgress });
        stateDb = await StateDB.init();
        const engine = new SyncEngine(stateDb);

        const result = await engine.run(config.sync_pairs, token, client, {
          onProgress: (msg: string) => {
            onProgress(msg);
          },
        });

        // Conflict notices in human mode
        if (!json) {
          for (const conflict of result.conflicts) {
            process.stdout.write(
              `[conflict] ${conflict.original} → ${conflict.conflictCopy}\n`,
            );
          }
        }

        if (json) {
          formatSuccess(
            {
              transferred: result.transferred,
              conflicts: result.conflicts.map((c: ConflictRecord) => ({
                original: c.original,
                conflictCopy: c.conflictCopy,
              })),
              errors: result.errors,
            },
            { json },
          );
          if (result.errors.length > 0) {
            process.exit(1);
          }
        } else {
          process.stdout.write(
            `Sync complete: ${result.transferred} file(s) transferred, ${result.conflicts.length} conflict(s) detected.\n`,
          );
          if (result.errors.length > 0) {
            for (const err of result.errors) {
              process.stderr.write(`error: SYNC_ERROR — ${err}\n`);
            }
            process.exit(1);
          }
        }
      } catch (err) {
        formatError(err, { json });
        process.exit(err instanceof ConfigError ? 2 : 1);
      } finally {
        stateDb?.close();
      }
    });
}
