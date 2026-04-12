/**
 * Minimal ambient type declaration for the bcryptjs npm package.
 * Only the async hash API is declared — synchronous variants are not used
 * in this codebase (blocking bcrypt in the engine event loop is forbidden).
 */
declare module "bcryptjs" {
  /** Asynchronously hash s using cost factor encoded in salt string. */
  export function hash(s: string, salt: string | number): Promise<string>;
  /** Synchronously hash s — do NOT call from the event loop; use hash(). */
  export function hashSync(s: string, salt: string | number): string;
}

/**
 * Minimal ambient type declaration for the undici npm package.
 * Only the APIs used for the Flatpak DNS override are declared here.
 */
declare module "undici" {
  export class Agent {
    constructor(options?: AgentOptions);
  }

  interface AgentOptions {
    /** Custom connector function — receives TLS options, must call callback with socket. */
    connect?: (
      opts: Record<string, unknown>,
      callback: (err: Error | null, socket: unknown) => void,
    ) => void;
  }

  export function setGlobalDispatcher(dispatcher: Agent): void;

  export function fetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response>;
}
