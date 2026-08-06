/**
 * Bundling presets for Paperclip plugins.
 *
 * These helpers return plain esbuild config objects so plugin authors do not
 * need to re-implement host contract defaults.
 */

export interface PluginBundlerPresetInput {
  manifestEntry?: string;
  workerEntry?: string;
  uiEntry?: string;
  outdir?: string;
  sourcemap?: boolean;
}

export interface EsbuildLikeOptions {
  entryPoints: string[];
  outdir: string;
  entryNames?: string;
  bundle: boolean;
  format: "esm";
  platform: "node" | "browser";
  target: string;
  sourcemap?: boolean;
  external?: string[];
}

export interface PluginBundlerPresets {
  esbuild: {
    worker: EsbuildLikeOptions;
    ui?: EsbuildLikeOptions;
    manifest: EsbuildLikeOptions;
  };
}

/**
 * Build esbuild baseline configs for plugin worker, manifest, and UI bundles.
 *
 * The presets intentionally externalize host/runtime deps (`react`, SDK packages)
 * to match the Paperclip plugin loader contract.
 */
export function createPluginBundlerPresets(input: PluginBundlerPresetInput = {}): PluginBundlerPresets {
  const uiExternal = [
    "@paperclipai/plugin-sdk/ui",
    "react",
    "react-dom",
    "react/jsx-runtime",
  ];

  const outdir = input.outdir ?? "dist";
  const workerEntry = input.workerEntry ?? "src/worker.ts";
  const manifestEntry = input.manifestEntry ?? "src/manifest.ts";
  const uiEntry = input.uiEntry;
  const sourcemap = input.sourcemap ?? true;

  const esbuildWorker: EsbuildLikeOptions = {
    entryPoints: [workerEntry],
    outdir,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22.13",
    sourcemap,
    external: ["react", "react-dom"],
  };

  const esbuildManifest: EsbuildLikeOptions = {
    entryPoints: [manifestEntry],
    outdir,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22.13",
    sourcemap,
    external: ["@paperclipai/plugin-sdk"],
  };

  const esbuildUi = uiEntry
    ? {
      entryPoints: [uiEntry],
      outdir: `${outdir}/ui`,
      entryNames: "index",
      bundle: true,
      format: "esm" as const,
      platform: "browser" as const,
      target: "es2022",
      sourcemap,
      external: uiExternal,
    }
    : undefined;

  return {
    esbuild: {
      worker: esbuildWorker,
      manifest: esbuildManifest,
      ...(esbuildUi ? { ui: esbuildUi } : {}),
    },
  };
}
