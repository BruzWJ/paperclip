import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { materializePublishManifest } from "./prepare-bundled-package.mjs";

const adapterUtilsPackage = JSON.parse(
  await readFile(new URL("../packages/adapter-utils/package.json", import.meta.url), "utf8"),
);
const releaseScript = await readFile(new URL("./release.sh", import.meta.url), "utf8");
const releaseLib = await readFile(new URL("./release-lib.sh", import.meta.url), "utf8");

test("published adapter-utils exposes and bundles the ACPX runtime", () => {
  assert.equal(adapterUtilsPackage.exports["./acp-subprocess"], undefined);
  assert.equal(
    adapterUtilsPackage.exports["./acpx-runtime"],
    "./src/acpx-runtime/index.ts",
  );
  assert.equal(adapterUtilsPackage.publishConfig.exports["./acp-subprocess"], undefined);
  assert.deepEqual(adapterUtilsPackage.publishConfig.exports["./acpx-runtime"], {
    types: "./dist/acpx-runtime/index.d.ts",
    import: "./dist/acpx-runtime/index.js",
  });
  assert.deepEqual(adapterUtilsPackage.bundleDependencies, ["acpx", "zod"]);
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
