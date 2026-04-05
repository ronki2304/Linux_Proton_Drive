import { ProtonDriveError } from "../errors.js";

export interface OutputOptions {
  json?: boolean;
}

export function formatSuccess(data: unknown, opts: OutputOptions): void {
  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok: true, data }) + "\n");
  } else if (typeof data === "string") {
    process.stdout.write(data + "\n");
  } else {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  }
}

export function formatError(err: unknown, opts: OutputOptions): void {
  const code = err instanceof ProtonDriveError ? err.code : "UNKNOWN";
  const message = err instanceof Error ? err.message : String(err);

  if (opts.json) {
    process.stderr.write(
      JSON.stringify({ ok: false, error: { code, message } }) + "\n",
    );
  } else {
    process.stderr.write(`error: ${code} — ${message}\n`);
  }
}

export function makeProgressCallback(
  prefix: string,
  opts: OutputOptions,
): (msg: string) => void {
  if (opts.json) {
    return () => {};
  }
  return (msg: string) => {
    process.stdout.write(`[${prefix}] ${msg}\n`);
  };
}
