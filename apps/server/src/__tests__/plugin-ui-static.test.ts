import express from "express";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

const pluginId = "11111111-1111-4111-8111-111111111111";
const tempDirs: string[] = [];

function createPluginPackage(source = "export default {};\n") {
  const packageRoot = path.join(
    tmpdir(),
    `paperclip-plugin-ui-static-${randomUUID()}`,
  );
  const uiDir = path.join(packageRoot, "dist", "ui");
  mkdirSync(uiDir, { recursive: true });
  writeFileSync(path.join(uiDir, "index.js"), source);
  tempDirs.push(packageRoot);
  return packageRoot;
}

function readyPlugin(
  packageRoot: string,
  uiEntrypoint = "./dist/ui",
) {
  mockRegistry.getById.mockResolvedValue({
    id: pluginId,
    pluginKey: "paperclip.example",
    packageName: "paperclip-plugin-example",
    packagePath: packageRoot,
    status: "ready",
    manifestJson: {
      id: "paperclip.example",
      entrypoints: {
        ui: uiEntrypoint,
      },
    },
  });
}

async function createApp(actor: Record<string, unknown>) {
  const [{ pluginUiStaticRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/plugin-ui-static.js"),
    import("../middleware/index.js"),
  ]);

  const app = express();
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use(pluginUiStaticRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("plugin UI static route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serves a built UI asset from the installation's persisted package path", async () => {
    readyPlugin(createPluginPackage("export const marker = 'static-bundle';\n"));
    const app = await createApp({ type: "none", source: "none" });

    const res = await request(app).get(`/_plugins/${pluginId}/ui/index.js`);

    expect(res.status).toBe(200);
    expect(res.text).toContain("static-bundle");
    expect(mockRegistry.getById).toHaveBeenCalledExactlyOnceWith(pluginId);
  });

  it("rejects a plugin key instead of treating it as an installation ID alias", async () => {
    const app = await createApp({ type: "none", source: "none" });

    const res = await request(app).get(
      "/_plugins/paperclip.example/ui/index.js",
    );

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid plugin installation ID" });
    expect(mockRegistry.getById).not.toHaveBeenCalled();
  });

  it("requires packagePath to be an absolute persisted package root", async () => {
    const packageRoot = createPluginPackage();
    readyPlugin(path.relative(process.cwd(), packageRoot));
    const app = await createApp({ type: "none", source: "none" });

    const res = await request(app).get(`/_plugins/${pluginId}/ui/index.js`);

    expect(res.status).toBe(404);
  });

  it("rejects UI entrypoints that escape or bypass the package root", async () => {
    const packageRoot = createPluginPackage();
    const outsideRoot = createPluginPackage("export const outside = true;\n");
    const app = await createApp({ type: "none", source: "none" });

    readyPlugin(
      packageRoot,
      path.relative(packageRoot, path.join(outsideRoot, "dist", "ui")),
    );
    const escaped = await request(app).get(`/_plugins/${pluginId}/ui/index.js`);

    readyPlugin(packageRoot, path.join(packageRoot, "dist", "ui"));
    const absolute = await request(app).get(`/_plugins/${pluginId}/ui/index.js`);

    expect(escaped.status).toBe(403);
    expect(absolute.status).toBe(403);
  });

  it("rejects a UI directory symlink that escapes the package root", async () => {
    const packageRoot = createPluginPackage();
    const outsideRoot = createPluginPackage("export const outside = true;\n");
    const uiDir = path.join(packageRoot, "dist", "ui");
    rmSync(uiDir, { recursive: true });
    symlinkSync(path.join(outsideRoot, "dist", "ui"), uiDir, "dir");
    readyPlugin(packageRoot);
    const app = await createApp({ type: "none", source: "none" });

    const res = await request(app).get(`/_plugins/${pluginId}/ui/index.js`);

    expect(res.status).toBe(403);
  });

  it("rejects an asset symlink that escapes the declared UI directory", async () => {
    const packageRoot = createPluginPackage();
    const outsideRoot = createPluginPackage("export const outside = true;\n");
    symlinkSync(
      path.join(outsideRoot, "dist", "ui", "index.js"),
      path.join(packageRoot, "dist", "ui", "escape.js"),
      "file",
    );
    readyPlugin(packageRoot);
    const app = await createApp({ type: "none", source: "none" });

    const res = await request(app).get(`/_plugins/${pluginId}/ui/escape.js`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Access denied" });
  });
});
