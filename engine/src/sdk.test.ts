import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

describe("SDK boundary enforcement", () => {
  const srcDir = path.resolve(import.meta.dirname!, ".");

  it("sdk.ts has boundary comment", () => {
    const content = fs.readFileSync(path.join(srcDir, "sdk.ts"), "utf8");
    assert.ok(
      content.includes("SDK BOUNDARY"),
      "sdk.ts must have SDK BOUNDARY comment",
    );
  });

  it("errors.ts has zero internal imports", () => {
    const content = fs.readFileSync(path.join(srcDir, "errors.ts"), "utf8");
    const internalImports = content.match(/from ["']\.\/.*["']/g);
    assert.equal(
      internalImports,
      null,
      "errors.ts must not import from any other engine file",
    );
  });

  it("ipc.ts does not import from sdk.ts", () => {
    const content = fs.readFileSync(path.join(srcDir, "ipc.ts"), "utf8");
    assert.ok(
      !content.includes('from "./sdk'),
      "ipc.ts must not import from sdk.ts",
    );
  });

  it("sdk.ts only imports from errors.ts internally", () => {
    const content = fs.readFileSync(path.join(srcDir, "sdk.ts"), "utf8");
    const internalImports = content.match(/from ["']\.\/[^"']+["']/g) ?? [];

    for (const imp of internalImports) {
      assert.ok(
        imp.includes("errors"),
        `sdk.ts may only import from errors.ts, found: ${imp}`,
      );
    }
  });

  it("no other engine file imports @protontech/drive-sdk", () => {
    const files = fs.readdirSync(srcDir).filter(
      (f) => f.endsWith(".ts") && f !== "sdk.ts" && f !== "sdk.test.ts",
    );

    for (const file of files) {
      const content = fs.readFileSync(path.join(srcDir, file), "utf8");
      assert.ok(
        !content.includes("@protontech/drive-sdk"),
        `${file} must not import @protontech/drive-sdk directly`,
      );
    }
  });
});
