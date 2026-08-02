import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyControlUiReleaseParity } from "../../scripts/verify-control-ui-release-parity.mjs";

const fullFiles = Object.freeze({
  "index.html": "<!doctype html><script src=\"/assets/app.js\"></script>",
  "assets/app.js": "console.log('openclaw');\n",
  "assets/app.js.map": "{\"version\":3,\"sources\":[\"app.ts\"]}\n",
});

const runtimeFiles = Object.freeze({
  "index.html": fullFiles["index.html"],
  "assets/app.js": fullFiles["assets/app.js"],
});

function writeTree(root: string, files: Readonly<Record<string, string>>): void {
  for (const [relativePath, body] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body, "utf8");
  }
}

function createRoots(files: {
  app: Readonly<Record<string, string>>;
  runtime: Readonly<Record<string, string>>;
}) {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "openclaw-control-ui-parity-"));
  const roots = {
    fixtureRoot,
    rootUi: path.join(fixtureRoot, "root"),
    appUi: path.join(fixtureRoot, "app"),
    runtimeUi: path.join(fixtureRoot, "runtime"),
  };
  writeTree(roots.rootUi, fullFiles);
  writeTree(roots.appUi, files.app);
  writeTree(roots.runtimeUi, files.runtime);
  return roots;
}

describe("Control UI release parity", () => {
  it("accepts runtime packaging that omits only official source-map exclusions", () => {
    const roots = createRoots({ app: fullFiles, runtime: runtimeFiles });
    try {
      const manifests = verifyControlUiReleaseParity(roots);
      expect(manifests.root).toEqual(manifests.app);
      expect(manifests.rootRuntime).toEqual(manifests.runtime);
      expect(manifests.root.map((entry) => entry.path)).toContain("assets/app.js.map");
      expect(manifests.runtime.map((entry) => entry.path)).not.toContain("assets/app.js.map");
    } finally {
      rmSync(roots.fixtureRoot, { force: true, recursive: true });
    }
  });

  it("rejects a runtime package that is missing executable UI assets", () => {
    const roots = createRoots({
      app: fullFiles,
      runtime: { "index.html": runtimeFiles["index.html"] },
    });
    try {
      expect(() => verifyControlUiReleaseParity(roots)).toThrow(
        "Control UI manifest mismatch: runtime package set versus runtime",
      );
    } finally {
      rmSync(roots.fixtureRoot, { force: true, recursive: true });
    }
  });

  it("rejects App drift even when the difference is only a source map", () => {
    const roots = createRoots({ app: runtimeFiles, runtime: runtimeFiles });
    try {
      expect(() => verifyControlUiReleaseParity(roots)).toThrow(
        "Control UI manifest mismatch: root versus app",
      );
    } finally {
      rmSync(roots.fixtureRoot, { force: true, recursive: true });
    }
  });

  it("rejects runtime source maps that violate the official package files contract", () => {
    const roots = createRoots({ app: fullFiles, runtime: fullFiles });
    try {
      expect(() => verifyControlUiReleaseParity(roots)).toThrow(
        "Runtime Control UI unexpectedly contains package-excluded source maps",
      );
    } finally {
      rmSync(roots.fixtureRoot, { force: true, recursive: true });
    }
  });
});
