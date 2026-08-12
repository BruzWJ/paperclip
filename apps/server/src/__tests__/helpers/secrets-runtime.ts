import os from "node:os";
import path from "node:path";
import type { SecretsRuntimeConfig } from "../../secrets/types.js";

export function testSecretsRuntimeConfig(
  overrides: Partial<SecretsRuntimeConfig> = {},
): SecretsRuntimeConfig {
  return {
    defaultProvider: "local_encrypted",
    strictMode: false,
    masterKeyFilePath: path.join(
      os.tmpdir(),
      `paperclip-test-master-${process.pid}.key`,
    ),
    ...overrides,
  };
}
