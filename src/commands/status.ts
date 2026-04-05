import type { Command } from "commander";
import { loadConfig } from "../core/config.js";
import { StateDB } from "../core/state-db.js";
import { formatSuccess, formatError } from "../core/output.js";
import { ConfigError } from "../errors.js";
import type { SyncPairStatus, SyncStateRecord } from "../types.js";

type PairState = SyncStateRecord["state"];

const STATE_PRIORITY: Record<PairState, number> = {
  conflict: 4,
  error: 3,
  pending: 2,
  synced: 1,
};

function aggregateState(records: SyncStateRecord[]): PairState {
  if (records.length === 0) return "pending";
  return records.reduce<PairState>((worst, r) => {
    return STATE_PRIORITY[r.state]! > STATE_PRIORITY[worst]! ? r.state : worst;
  }, "synced");
}

export function register(program: Command): void {
  program
    .command("status")
    .description("Show sync status for all configured pairs")
    .action(async () => {
      const opts = program.opts() as { json?: boolean; config?: string };
      const json = opts.json ?? false;

      let stateDb: StateDB | undefined;
      try {
        // Config-first, fail-fast — no network calls ever in status
        const config = await loadConfig(opts.config);
        stateDb = await StateDB.init();

        const pairStatuses: SyncPairStatus[] = [];
        for (const pair of config.sync_pairs) {
          const records = stateDb.getAll(pair.id);
          const state = aggregateState(records);
          const lastSyncMtime = stateDb.getLastSync(pair.id);
          pairStatuses.push({ syncPair: pair, state, lastSyncMtime });
        }

        // Overall most recent mtime across all pairs
        const lastSync =
          pairStatuses
            .map((p) => p.lastSyncMtime)
            .filter((m): m is string => m !== null)
            .sort()
            .at(-1) ?? null;

        if (json) {
          formatSuccess(
            {
              pairs: pairStatuses.map((p) => ({
                id: p.syncPair.id,
                local: p.syncPair.local,
                remote: p.syncPair.remote,
                state: p.state,
                last_sync_mtime: p.lastSyncMtime,
              })),
              last_sync: lastSync,
            },
            { json },
          );
        } else {
          process.stdout.write("Sync status:\n");
          for (const p of pairStatuses) {
            const lastSyncStr = p.lastSyncMtime ?? "never";
            process.stdout.write(
              `  ${p.syncPair.id}:\t${p.syncPair.local}  ↔  ${p.syncPair.remote}  [${p.state}]  last sync: ${lastSyncStr}\n`,
            );
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
