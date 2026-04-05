import { describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

const PROJECT_ROOT = join(import.meta.dir, "..");

describe("Project initialization (Story 1.1)", () => {
  test("bun.lock exists (bun install ran successfully)", () => {
    expect(existsSync(join(PROJECT_ROOT, "bun.lock"))).toBe(true);
  });

  test("tsconfig.json has required compiler options", async () => {
    const tsconfig = await Bun.file(join(PROJECT_ROOT, "tsconfig.json")).text();
    const parsed = JSON.parse(tsconfig);
    expect(parsed.compilerOptions.module).toBe("ESNext");
    expect(parsed.compilerOptions.target).toBe("ES2022");
    expect(parsed.compilerOptions.strict).toBe(true);
  });

  test("bunfig.toml exists with [test] section", async () => {
    const bunfig = await Bun.file(join(PROJECT_ROOT, "bunfig.toml")).text();
    expect(bunfig).toContain("[test]");
  });

  test("src/cli.ts entry point exists", () => {
    expect(existsSync(join(PROJECT_ROOT, "src", "cli.ts"))).toBe(true);
  });

  test("src/sdk/client.ts SDK boundary file exists", () => {
    expect(existsSync(join(PROJECT_ROOT, "src", "sdk", "client.ts"))).toBe(true);
  });

  test("src/sdk/client.ts imports from @protontech/drive-sdk (boundary check)", async () => {
    const clientTs = await Bun.file(join(PROJECT_ROOT, "src", "sdk", "client.ts")).text();
    // Must import from the SDK
    expect(clientTs).toContain("@protontech/drive-sdk");
    // May import from ../errors and ../types (shared root-level modules) but NOT from
    // ../commands/, ../auth/, ../core/ (one-way dependency enforcement)
    const forbiddenImports = clientTs.match(/from\s+["']\.\.?\/(commands|auth|core)\//g);
    expect(forbiddenImports).toBeNull();
  });

  test("dist/ is in .gitignore", async () => {
    const gitignore = await Bun.file(join(PROJECT_ROOT, ".gitignore")).text();
    expect(gitignore).toContain("dist");
  });

  test("LICENSE file exists (MIT)", async () => {
    expect(existsSync(join(PROJECT_ROOT, "LICENSE"))).toBe(true);
    const license = await Bun.file(join(PROJECT_ROOT, "LICENSE")).text();
    expect(license).toContain("MIT License");
  });
});

describe("Binary compilation (Story 1.1 AC: 2)", () => {
  test("bun build --compile produces binary at dist/protondrive", () => {
    const result = spawnSync(
      "bun",
      ["build", "--compile", "src/cli.ts", "--outfile", "dist/protondrive"],
      { cwd: PROJECT_ROOT, encoding: "utf8" }
    );
    expect(result.status).toBe(0);
    expect(existsSync(join(PROJECT_ROOT, "dist", "protondrive"))).toBe(true);
  });

  test("compiled binary responds to --version without Node.js runtime", () => {
    const binary = join(PROJECT_ROOT, "dist", "protondrive");
    const result = spawnSync(binary, ["--version"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
