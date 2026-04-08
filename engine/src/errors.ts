// Zero internal imports — this file is imported by all other engine files.

export class EngineError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EngineError";
  }
}

export class SyncError extends EngineError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SyncError";
  }
}

export class NetworkError extends EngineError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NetworkError";
  }
}

export class IpcError extends EngineError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IpcError";
  }
}

export class ConfigError extends EngineError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigError";
  }
}
