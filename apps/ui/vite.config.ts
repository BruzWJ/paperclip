import path from "path";
import fs from "node:fs";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { createUiDevWatchOptions } from "./src/lib/vite-watch";

const PRECOMPRESS_EXTENSIONS = new Set([".js", ".css", ".svg", ".json", ".txt", ".wasm"]);
const PRECOMPRESS_TEXT_EXTENSIONS = new Set([".js", ".css", ".svg", ".json", ".txt"]);
const PRECOMPRESS_MIN_BYTES = 1024;

// Emits sibling <name>.gz / <name>.br files for every compressible build
// output so the server can serve precompressed variants (see apps/server
// src/middleware/static-precompressed.ts). `apply: "build"` + the writeBundle
// hook mean this never runs during `vite dev` or vitest.
function precompressAssetsPlugin(): Plugin {
  const compressDir = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        compressDir(filePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (ext === ".gz" || ext === ".br" || !PRECOMPRESS_EXTENSIONS.has(ext)) continue;
      const source = fs.readFileSync(filePath);
      if (source.length <= PRECOMPRESS_MIN_BYTES) continue;
      fs.writeFileSync(`${filePath}.gz`, gzipSync(source, { level: 9 }));
      const brotliParams: Record<number, number> = {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: source.length,
      };
      if (PRECOMPRESS_TEXT_EXTENSIONS.has(ext)) {
        brotliParams[zlibConstants.BROTLI_PARAM_MODE] = zlibConstants.BROTLI_MODE_TEXT;
      }
      fs.writeFileSync(`${filePath}.br`, brotliCompressSync(source, { params: brotliParams }));
    }
  };

  return {
    name: "paperclip:precompress-assets",
    apply: "build",
    writeBundle(options) {
      const outDir = options.dir ?? (options.file ? path.dirname(options.file) : undefined);
      if (!outDir || !fs.existsSync(outDir)) return;
      compressDir(outDir);
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      routesDirectory: "./src/routes",
      generatedRouteTree: "./src/routeTree.gen.ts",
      routeFileIgnorePrefix: "-",
      routeFileIgnorePattern: "\\.test\\.(ts|tsx)$",
    }),
    react(),
    tailwindcss(),
    precompressAssetsPlugin(),
  ],
  build: {
    minify: "esbuild",
  },
  esbuild:
    mode === "production"
      ? {
          drop: ["console", "debugger"],
          legalComments: "none",
        }
      : undefined,
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    watch: createUiDevWatchOptions(process.cwd()),
    proxy: {
      "/api": {
        target: "http://localhost:3100",
        ws: true,
      },
    },
  },
}));
