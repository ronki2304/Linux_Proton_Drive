import { Command } from "commander";
import "./sdk/client.js";
import { ConfigError, ProtonDriveError } from "./errors.js";
import { formatError } from "./core/output.js";
import * as authLogin from "./commands/auth-login.js";
import * as authLogout from "./commands/auth-logout.js";
import * as sync from "./commands/sync.js";
import * as upload from "./commands/upload.js";
import * as download from "./commands/download.js";
import * as status from "./commands/status.js";
import pkg from "../package.json" with { type: "json" };

const program = new Command();

program
  .name("protondrive")
  .description("ProtonDrive Linux CLI client")
  .version(pkg.version)
  .option("--json", "Machine-readable JSON output")
  .option("--config <path>", "Path to config file (default: ~/.config/protondrive/config.yaml)");

// Auth subcommand group
const auth = program.command("auth").description("Authentication commands");
authLogin.register(auth);
authLogout.register(auth);

// Top-level commands
sync.register(program);
upload.register(program);
download.register(program);
status.register(program);

// Unknown command handler
program.on("command:*", () => {
  const unknown = program.args.length > 0 ? program.args.join(" ") : "<empty>";
  console.error(`error: unknown command '${unknown}'`);
  console.error("Run 'protondrive --help' for usage.");
  process.exit(2);
});

const jsonMode = process.argv.includes("--json");

try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (err instanceof ConfigError) {
    formatError(err, { json: jsonMode });
    process.exit(2);
  } else if (err instanceof ProtonDriveError) {
    formatError(err, { json: jsonMode });
    process.exit(1);
  } else if (err instanceof Error) {
    formatError(err, { json: jsonMode });
    process.exit(1);
  }
  throw err;
}
