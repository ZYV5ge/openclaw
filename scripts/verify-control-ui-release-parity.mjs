#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SOURCE_MAP_SUFFIX = ".map";

const sha256 = (body) => crypto.createHash("sha256").update(body).digest("hex");

export function isRuntimePackagedControlUiPath(relativePath) {
  return !relativePath.endsWith(SOURCE_MAP_SUFFIX);
}

export function buildControlUiManifest(root, relative = "") {
  const current = path.join(root, relative);
  return fs
    .readdirSync(current, { withFileTypes: true })
    .toSorted((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const next = relative ? relative + "/" + entry.name : entry.name;
      if (entry.isDirectory()) {
        return buildControlUiManifest(root, next);
      }
      if (!entry.isFile()) {
        throw new Error("Unexpected Control UI entry: " + next);
      }
      const body = fs.readFileSync(path.join(root, next));
      return [{ path: next, bytes: body.length, sha256: sha256(body) }];
    });
}

function manifestDifference(expected, actual) {
  const expectedByPath = new Map(expected.map((entry) => [entry.path, entry]));
  const actualByPath = new Map(actual.map((entry) => [entry.path, entry]));
  return {
    missing: expected
      .filter((entry) => !actualByPath.has(entry.path))
      .map((entry) => entry.path),
    extra: actual
      .filter((entry) => !expectedByPath.has(entry.path))
      .map((entry) => entry.path),
    changed: expected
      .filter((entry) => {
        const candidate = actualByPath.get(entry.path);
        return (
          candidate !== undefined &&
          (candidate.bytes !== entry.bytes || candidate.sha256 !== entry.sha256)
        );
      })
      .map((entry) => entry.path),
  };
}

function requireMatchingManifest(expected, actual, label) {
  if (JSON.stringify(expected) === JSON.stringify(actual)) {
    return;
  }
  const difference = manifestDifference(expected, actual);
  throw new Error(
    "Control UI manifest mismatch: " +
      label +
      "; missing=" +
      JSON.stringify(difference.missing) +
      " extra=" +
      JSON.stringify(difference.extra) +
      " changed=" +
      JSON.stringify(difference.changed),
  );
}

export function verifyControlUiReleaseParity({ rootUi, appUi, runtimeUi }) {
  const root = buildControlUiManifest(rootUi);
  const app = buildControlUiManifest(appUi);
  const runtime = buildControlUiManifest(runtimeUi);
  requireMatchingManifest(root, app, "root versus app");

  const unexpectedRuntimeSourceMaps = runtime
    .filter((entry) => !isRuntimePackagedControlUiPath(entry.path))
    .map((entry) => entry.path);
  if (unexpectedRuntimeSourceMaps.length > 0) {
    throw new Error(
      "Runtime Control UI unexpectedly contains package-excluded source maps: " +
        JSON.stringify(unexpectedRuntimeSourceMaps),
    );
  }

  const rootRuntime = root.filter((entry) => isRuntimePackagedControlUiPath(entry.path));
  requireMatchingManifest(rootRuntime, runtime, "runtime package set versus runtime");
  if (!rootRuntime.some((entry) => entry.path === "index.html")) {
    throw new Error("Control UI runtime manifest is missing index.html");
  }
  if (!rootRuntime.some((entry) => entry.path.startsWith("assets/"))) {
    throw new Error("Control UI runtime manifest contains no assets");
  }
  return { root, app, rootRuntime, runtime };
}

export function writeControlUiReleaseParityReport({
  rootUi,
  appUi,
  runtimeUi,
  manifestDir,
}) {
  const manifests = verifyControlUiReleaseParity({ rootUi, appUi, runtimeUi });
  const filenames = {
    root: "control-ui-root.manifest.json",
    app: "control-ui-app.manifest.json",
    rootRuntime: "control-ui-root-runtime.manifest.json",
    runtime: "control-ui-runtime.manifest.json",
  };
  fs.mkdirSync(manifestDir, { recursive: true });
  for (const [name, manifest] of Object.entries(manifests)) {
    fs.writeFileSync(
      path.join(manifestDir, filenames[name]),
      JSON.stringify(manifest, null, 2) + "\n",
    );
  }
  return manifests;
}
