import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import cliEsbuildConfig from "../packages/cli/esbuild.config.mjs";
import { bundledCliNpmDependencies } from "./cli-bundled-npm-dependencies.mjs";
import { materializePublishManifest } from "./prepare-bundled-package.mjs";

const rootPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const adapterUtilsPackage = JSON.parse(
  await readFile(new URL("../packages/adapter-utils/package.json", import.meta.url), "utf8"),
);
const releaseScript = await readFile(new URL("./release.sh", import.meta.url), "utf8");
const releaseLib = await readFile(new URL("./release-lib.sh", import.meta.url), "utf8");

test("published packages preserve the dynamic ACPX registry and official ACP client", () => {
  assert.equal(rootPackage.pnpm.patchedDependencies, undefined);
  assert.equal(adapterUtilsPackage.dependencies.acpx, "0.13.0");
  assert.equal(adapterUtilsPackage.dependencies["@agentclientprotocol/sdk"], "1.3.0");
  assert.deepEqual(
    Object.keys(adapterUtilsPackage.dependencies).filter(
      (name) =>
        name.startsWith("@agentclientprotocol/") &&
        name !== "@agentclientprotocol/sdk",
    ),
    [],
  );
  assert.equal(adapterUtilsPackage.dependencies.zod, "4.4.3");
  assert.deepEqual(adapterUtilsPackage.bundleDependencies, [
    "@agentclientprotocol/sdk",
    "acpx",
    "zod",
  ]);
  assert.equal(bundledCliNpmDependencies.has("acpx"), true);
  assert.equal(cliEsbuildConfig.external.includes("acpx"), false);
});

test("bundled package staging materializes publishConfig entrypoints", () => {
  const staged = materializePublishManifest(adapterUtilsPackage);

  assert.equal(staged.publishConfig, undefined);
  assert.equal(staged.main, "./dist/index.js");
  assert.equal(staged.types, "./dist/index.d.ts");
  assert.deepEqual(staged.exports, adapterUtilsPackage.publishConfig.exports);
});

test("bundled package dry runs preview without querying published versions", () => {
  assert.match(releaseScript, /run_bundled_npm_pack pack --pack-destination "\$publish_dir"/);
  assert.match(releaseLib, /BUNDLED_NPM_PACK_VERSION="10\.9\.7"/);
  assert.match(releaseLib, /BUNDLED_NPM_PUBLISH_VERSION="11\.18\.0"/);
  assert.match(releaseLib, /npx --yes "npm@\$BUNDLED_NPM_PACK_VERSION"/);
  assert.match(releaseLib, /npx --yes "npm@\$BUNDLED_NPM_PUBLISH_VERSION"/);
  assert.match(releaseLib, /"\$@" --loglevel verbose/);
});
