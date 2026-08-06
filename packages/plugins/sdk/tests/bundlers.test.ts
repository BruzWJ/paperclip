import { describe, expect, it } from "vitest";
import { createPluginBundlerPresets } from "../src/bundlers.js";

describe("createPluginBundlerPresets", () => {
  it("always emits the host-defined UI entry filename", () => {
    const presets = createPluginBundlerPresets({
      uiEntry: "src/ui/panel.tsx",
    });

    expect(presets.esbuild.ui).toMatchObject({
      entryPoints: ["src/ui/panel.tsx"],
      outdir: "dist/ui",
      entryNames: "index",
    });
    expect(presets.esbuild.worker).not.toHaveProperty("minify");
    expect(presets.esbuild.ui).not.toHaveProperty("minify");
    expect(presets.esbuild.ui?.external).toContain("@paperclipai/plugin-sdk/ui");
    expect(presets.esbuild.ui?.external).not.toContain("@paperclipai/plugin-sdk/ui/hooks");
  });
});
