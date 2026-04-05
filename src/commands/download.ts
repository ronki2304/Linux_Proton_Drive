import type { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import { getSessionToken } from "../auth/credentials.js";
import { DriveClient } from "../sdk/client.js";
import { formatSuccess, formatError, makeProgressCallback } from "../core/output.js";
import { SyncError, ConfigError } from "../errors.js";

async function atomicDownload(
  client: DriveClient,
  remotePath: string,
  localPath: string,
): Promise<void> {
  const tmpPath = localPath + ".protondrive-tmp";
  const dir = path.dirname(localPath);
  fs.mkdirSync(dir, { recursive: true });
  try {
    await client.downloadFile(remotePath, tmpPath);
    fs.renameSync(tmpPath, localPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // swallow — don't mask original error
    }
    throw err;
  }
}

export function register(program: Command): void {
  program
    .command("download")
    .description("Download a file from ProtonDrive")
    .argument("<remote>", "Remote file or directory path")
    .argument("<local>", "Local destination path")
    .action(async (remote: string, local: string) => {
      const opts = program.opts() as { json?: boolean };
      const json = opts.json ?? false;
      const onProgress = makeProgressCallback("download", { json });
      try {
        const token = await getSessionToken();
        const client = new DriveClient(token, { onProgress });

        // List remote — for a single file, listFolder returns [] (no children)
        // The download is attempted; if remote doesn't exist the SDK throws.
        const remoteItems = await client.listFolder(remote);
        let transferred = 0;

        if (remoteItems.length === 0) {
          // Single file download
          onProgress(`Downloading ${remote}...`);
          await atomicDownload(client, remote, local);
          transferred = 1;
        } else {
          // Directory download
          for (const item of remoteItems) {
            if (!item.isFolder) {
              const relPath = item.remotePath.startsWith(remote + "/")
            ? item.remotePath.slice(remote.length + 1)
            : path.basename(item.remotePath);
          const localDest = path.join(local, relPath);
              onProgress(`Downloading ${item.remotePath}...`);
              await atomicDownload(client, item.remotePath, localDest);
              transferred++;
            }
          }
        }

        formatSuccess({ transferred, path: local }, { json });
        if (!json) {
          process.stdout.write(`Downloaded ${transferred} file(s) to ${local}\n`);
        }
      } catch (err) {
        formatError(err, { json });
        process.exit(err instanceof ConfigError ? 2 : 1);
      }
    });
}
