import type { SessionToken } from "./types.js";

export class ProtonDriveError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProtonDriveError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class AuthError extends ProtonDriveError {
  constructor(message: string, code = "AUTH_ERROR") {
    super(code, message);
    this.name = "AuthError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class SyncError extends ProtonDriveError {
  constructor(message: string, code = "SYNC_ERROR") {
    super(code, message);
    this.name = "SyncError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NetworkError extends ProtonDriveError {
  constructor(message: string, code = "NETWORK_ERROR") {
    super(code, message);
    this.name = "NetworkError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ConfigError extends ProtonDriveError {
  constructor(message: string, code = "CONFIG_ERROR") {
    super(code, message);
    this.name = "ConfigError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class TwoFactorRequiredError extends AuthError {
  constructor(public readonly challenge: SessionToken) {
    super("2FA is required — enter your authenticator app code.", "TWO_FACTOR_REQUIRED");
    this.name = "TwoFactorRequiredError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
