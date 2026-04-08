// SDK BOUNDARY: All @protontech/drive-sdk imports MUST be confined to this file.
// No other engine file may import the SDK directly.
// openpgp imports are also confined here.

import { NetworkError } from "./errors.js";

/**
 * DriveClient wraps @protontech/drive-sdk behind a stable interface.
 *
 * All other engine files import DriveClient from this module.
 * This isolation insulates the codebase from SDK version churn
 * (pre-release 0.14.3 — treat every bump as breaking).
 *
 * TODO: Wire actual @protontech/drive-sdk once npm package is available.
 * The SDK and openpgp imports will be added when implementing Epic 2.
 */
export interface AccountInfo {
  display_name: string;
  email: string;
  storage_used: number;
  storage_total: number;
  plan: string;
}

export class DriveClient {
  private token: string | null = null;

  async validateSession(token: string): Promise<AccountInfo> {
    // TODO: Call @protontech/drive-sdk to validate token
    // For now, return placeholder — real implementation in Epic 2
    this.token = token;
    throw new NetworkError("SDK not yet integrated — placeholder");
  }

  isAuthenticated(): boolean {
    return this.token !== null;
  }
}
