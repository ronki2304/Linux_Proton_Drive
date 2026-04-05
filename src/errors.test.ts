import { describe, test, expect } from "bun:test";
import {
  ProtonDriveError,
  AuthError,
  SyncError,
  NetworkError,
  ConfigError,
} from "./errors.js";

describe("ProtonDriveError base class", () => {
  test("has code and message fields", () => {
    const err = new ProtonDriveError("TEST_CODE", "test message");
    expect(err.code).toBe("TEST_CODE");
    expect(err.message).toBe("test message");
    expect(err.name).toBe("ProtonDriveError");
  });

  test("is an instance of Error", () => {
    const err = new ProtonDriveError("CODE", "msg");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("AuthError", () => {
  test("is instanceof ProtonDriveError and Error", () => {
    const err = new AuthError("bad credentials");
    expect(err).toBeInstanceOf(AuthError);
    expect(err).toBeInstanceOf(ProtonDriveError);
    expect(err).toBeInstanceOf(Error);
  });

  test("default code is AUTH_ERROR", () => {
    const err = new AuthError("bad credentials");
    expect(err.code).toBe("AUTH_ERROR");
  });

  test("accepts custom code", () => {
    const err = new AuthError("2FA not supported", "AUTH_2FA_UNSUPPORTED");
    expect(err.code).toBe("AUTH_2FA_UNSUPPORTED");
  });

  test("name is AuthError", () => {
    expect(new AuthError("msg").name).toBe("AuthError");
  });
});

describe("SyncError", () => {
  test("is instanceof ProtonDriveError and Error", () => {
    const err = new SyncError("sync failed");
    expect(err).toBeInstanceOf(SyncError);
    expect(err).toBeInstanceOf(ProtonDriveError);
    expect(err).toBeInstanceOf(Error);
  });

  test("default code is SYNC_ERROR", () => {
    expect(new SyncError("msg").code).toBe("SYNC_ERROR");
  });

  test("name is SyncError", () => {
    expect(new SyncError("msg").name).toBe("SyncError");
  });
});

describe("NetworkError", () => {
  test("is instanceof ProtonDriveError and Error", () => {
    const err = new NetworkError("timeout");
    expect(err).toBeInstanceOf(NetworkError);
    expect(err).toBeInstanceOf(ProtonDriveError);
    expect(err).toBeInstanceOf(Error);
  });

  test("default code is NETWORK_ERROR", () => {
    expect(new NetworkError("msg").code).toBe("NETWORK_ERROR");
  });

  test("name is NetworkError", () => {
    expect(new NetworkError("msg").name).toBe("NetworkError");
  });
});

describe("ConfigError", () => {
  test("is instanceof ProtonDriveError and Error", () => {
    const err = new ConfigError("missing config");
    expect(err).toBeInstanceOf(ConfigError);
    expect(err).toBeInstanceOf(ProtonDriveError);
    expect(err).toBeInstanceOf(Error);
  });

  test("default code is CONFIG_ERROR", () => {
    expect(new ConfigError("msg").code).toBe("CONFIG_ERROR");
  });

  test("name is ConfigError", () => {
    expect(new ConfigError("msg").name).toBe("ConfigError");
  });
});

describe("Error hierarchy discriminability", () => {
  test("ConfigError is NOT instanceof SyncError", () => {
    expect(new ConfigError("msg")).not.toBeInstanceOf(SyncError);
  });

  test("AuthError is NOT instanceof ConfigError", () => {
    expect(new AuthError("msg")).not.toBeInstanceOf(ConfigError);
  });

  test("NetworkError is NOT instanceof AuthError", () => {
    expect(new NetworkError("msg")).not.toBeInstanceOf(AuthError);
  });
});
