import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));

describe("server package build script", () => {
  it("copies available static runtime asset directories into dist", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const buildScript = packageJson.scripts?.build ?? "";

    expect(buildScript).toContain("mkdir -p dist/onboarding-assets");
    expect(buildScript).toContain(
      "if [ -d src/onboarding-assets ]; then cp -R src/onboarding-assets/. dist/onboarding-assets/; fi",
    );
    expect(buildScript).not.toContain("built-ins");
  });
});
