/**
 * SRPModule adapter for the ProtonDrive SDK.
 *
 * Wraps the SRP implementation from src/auth/srp.ts to satisfy the
 * SRPModule interface required by ProtonDriveClient constructor.
 *
 * This is the only file in src/sdk/ that imports from ../auth/.
 */

import type { SRPModule } from "@protontech/drive-sdk/dist/crypto/interface.js";
import { buildSRPProof, deriveKeyPassword } from "../auth/srp.js";

export const srpModule: SRPModule = {
  async getSrp(version, _modulus, serverEphemeral, salt, password) {
    return buildSRPProof(version, serverEphemeral, salt, password);
  },

  async getSrpVerifier(_password) {
    // Not used for file operations; only needed for public link password setup
    throw new Error("getSrpVerifier not implemented — not needed for file operations");
  },

  async computeKeyPassword(password, keySalt) {
    return deriveKeyPassword(password, keySalt);
  },
};
