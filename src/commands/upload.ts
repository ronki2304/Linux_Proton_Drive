import type { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import { getSessionToken } from "../auth/credentials.js";
import { DriveClient } from "../sdk/client.js";
import { formatSuccess, formatError, makeProgressCallback } from "../core/output.js";
import { SyncError, ConfigError } from "../errors.js";

function collectFiles(localPath: string): string[] {
  const stat = fs.statSync(localPath);
  if (stat.isDirectory()) {
    const entries = fs.readdirSync(localPath, { recursive: true, encoding: "utf8" }) as string[];
    return entries
      .map((entry) => path.join(localPath, entry))
      .filter((p) => fs.statSync(p, { throwIfNoEntry: false })?.isFile() ?? false);
  }
  return [localPath];
}

export function register(program: Command): void {
  program
    .command("upload")
    .description("Upload a file to ProtonDrive")
    .argument("<local>", "Local file or directory path")
    .argument("<remote>", "Remote destination path")
    .action(async (local: string, remote: string) => {
      const opts = program.opts() as { json?: boolean };
      const json = opts.json ?? false;
      const onProgress = makeProgressCallback("upload", { json });
      try {
        const token = await getSessionToken();
        const client = new DriveClient(token, { onProgress });

        if (!fs.existsSync(local)) {
          throw new SyncError(
            `Local path not found: ${local}`,
            "FILE_NOT_FOUND",
          );
        }

        const files = collectFiles(local);
        let transferred = 0;
        const baseStat = fs.statSync(local);

        for (const file of files) {
          const relPath = baseStat.isDirectory()
            ? path.join(remote, path.relative(local, file))
            : remote;
          onProgress(`Uploading ${file}...`);
          await client.uploadFile(file, relPath);
          transferred++;
        }

        formatSuccess({ transferred, path: remote }, { json });
        if (!json) {
          process.stdout.write(`Uploaded ${transferred} file(s) to ${remote}\n`);
        }
      } catch (err) {
        formatError(err, { json });
        process.exit(err instanceof ConfigError ? 2 : 1);
      }
    });
}
