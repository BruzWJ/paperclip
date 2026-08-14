import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { createUiDevWatchOptions } from "./src/lib/vite-watch";

/**
 * Browser-test-only UI server. Playwright owns every API and Socket.IO
 * response, so this server has no backend proxy and never loads dotenv files.
 */
export default defineConfig({
  envDir: false,
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
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    watch: createUiDevWatchOptions(process.cwd()),
  },
});
