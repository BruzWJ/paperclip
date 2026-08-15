// @vitest-environment node

import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function productionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) return productionSources(absolutePath);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
      return [];
    }
    return [absolutePath];
  });
}

function filesContaining(pattern: RegExp): string[] {
  return productionSources(sourceRoot)
    .filter((file) => pattern.test(readFileSync(file, "utf8")))
    .map((file) => relative(sourceRoot, file))
    .sort();
}

describe("canonical Socket.IO live refresh boundary", () => {
  it("has no legacy router, Start runtime, raw WebSocket, or service-worker path", () => {
    expect(
      filesContaining(
        /react-router-dom|from\s+["']react-router["']|@tanstack\/(?:react-)?start|\bnew\s+WebSocket\s*\(|navigator\.serviceWorker|serviceWorker\.register|\/sw\.js/,
      ),
    ).toEqual([]);
  });

  it("has no cross-tab or shared-polling transport", () => {
    expect(filesContaining(/useSharedPolling|cross-tab-poll|BroadcastChannel/)).toEqual([]);
  });

  it("limits query intervals to explicit operational diagnostics", () => {
    expect(filesContaining(/\brefetchInterval\s*:/)).toEqual([
      "adapters/use-adapter-catalog.ts",
      "routes/_authenticated/$companyId/-shell/-Layout.tsx",
      "routes/_authenticated/$companyId/company/settings/instance/plugins/$pluginId/index.tsx",
      "routes/_authenticated/$companyId/company/settings/secrets/-useSecretsData.ts",
      "routes/_authenticated/-AuthenticatedAppGate.tsx",
    ]);
  });

  it("has no focus-triggered domain refresh path", () => {
    expect(filesContaining(/refetchOnWindowFocus\s*:\s*true/)).toEqual([]);
  });

  it("limits repeating browser timers to clocks and performance cleanup", () => {
    expect(filesContaining(/\bsetInterval\s*\(/)).toEqual([
      "hooks/useDateRange.ts",
      "lib/perf-measure-reaper.ts",
    ]);
  });
});
