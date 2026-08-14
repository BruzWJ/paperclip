import type { DeploymentExposure } from "@paperclipai/shared";
import express, { type Application, type Request as ExpressRequest } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RequestAuthorityBoundary } from "./http/request-authority.js";
import { staticPrecompressed } from "./middleware/static-precompressed.js";
import { readBrandedStaticIndexHtml } from "./static-index-html.js";
import { applyUiBranding } from "./ui-branding.js";
import { createCachedViteHtmlRenderer } from "./vite-html-renderer.js";

export type UiMode = "none" | "static" | "vite-dev";

const VITE_DEV_ASSET_PREFIXES = [
  "/@fs/",
  "/@id/",
  "/@react-refresh",
  "/@vite/",
  "/assets/",
  "/node_modules/",
  "/src/",
];

const VITE_DEV_STATIC_PATHS = new Set([
  "/apple-touch-icon.png",
  "/favicon-16x16.png",
  "/favicon-32x32.png",
  "/favicon.ico",
  "/favicon.svg",
  "/site.webmanifest",
]);

export function resolveViteHmrPort(serverPort: number): number {
  if (serverPort <= 55_535) return serverPort + 10_000;
  return Math.max(1_024, serverPort - 10_000);
}

export function resolveViteHmrHost(bindHost: string): string | undefined {
  const normalized = bindHost.trim().toLowerCase();
  if (normalized === "0.0.0.0" || normalized === "::") return undefined;
  return bindHost;
}

export function shouldServeViteDevHtml(req: ExpressRequest): boolean {
  const pathname = req.path;
  if (VITE_DEV_STATIC_PATHS.has(pathname)) return false;
  if (VITE_DEV_ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return false;
  }
  return req.accepts(["html"]) === "html";
}

export function requireStaticUiDist(moduleDirectory: string): string {
  const uiDist = path.resolve(moduleDirectory, "../ui-dist");
  const indexPath = path.join(uiDist, "index.html");
  if (!fs.existsSync(indexPath)) {
    throw new Error(`Static UI mode requires the canonical server artifact at ${indexPath}`);
  }
  return uiDist;
}

export interface BoardUiOptions {
  mode: UiMode;
  serverPort: number;
  bindHost: string;
  deploymentExposure: DeploymentExposure;
  requestAuthorityBoundary: RequestAuthorityBoundary;
}

export interface InstalledBoardUi {
  dispose(): Promise<void>;
}

function installStaticUi(app: Application, moduleDirectory: string) {
  const uiDist = requireStaticUiDist(moduleDirectory);
  app.use("/assets", staticPrecompressed(path.join(uiDist, "assets")));
  app.use(
    "/assets",
    express.static(path.join(uiDist, "assets"), {
      maxAge: "1y",
      immutable: true,
      setHeaders(res) {
        res.setHeader("Vary", "Accept-Encoding");
      },
    }),
  );
  app.use(
    express.static(uiDist, {
      maxAge: "1h",
      setHeaders(res, filePath) {
        if (path.basename(filePath) === "index.html") {
          res.set("Cache-Control", "no-cache");
        }
      },
    }),
  );
  app.get(/.*/, (req, res) => {
    if (req.path.startsWith("/assets/")) {
      res.status(404).end();
      return;
    }
    res
      .status(200)
      .set("Content-Type", "text/html")
      .set("Cache-Control", "no-cache")
      .end(readBrandedStaticIndexHtml(uiDist));
  });
}

async function installViteDevUi(app: Application, options: BoardUiOptions) {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const uiRoot = path.resolve(moduleDirectory, "../../ui");
  const publicUiRoot = path.resolve(uiRoot, "public");
  const hmrPort = resolveViteHmrPort(options.serverPort);
  const hmrHost = resolveViteHmrHost(options.bindHost);
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    root: uiRoot,
    appType: "custom",
    server: {
      middlewareMode: true,
      hmr: {
        ...(hmrHost ? { host: hmrHost } : {}),
        port: hmrPort,
        clientPort: hmrPort,
      },
      allowedHosts:
        options.deploymentExposure === "private"
          ? Array.from(options.requestAuthorityBoundary.policy.privateAllowedHostnames)
          : undefined,
    },
  });
  const renderer = createCachedViteHtmlRenderer({
    vite,
    uiRoot,
    brandHtml: applyUiBranding,
  });
  if (fs.existsSync(publicUiRoot)) {
    app.use(express.static(publicUiRoot, { index: false }));
  }
  app.get(/.*/, async (req, res, next) => {
    if (!shouldServeViteDevHtml(req)) {
      next();
      return;
    }
    try {
      const html = await renderer.render(req.originalUrl);
      res.status(200).set({ "Content-Type": "text/html" }).end(html);
    } catch (error) {
      next(error);
    }
  });
  app.use(vite.middlewares);
  return renderer;
}

export async function installBoardUi(app: Application, options: BoardUiOptions): Promise<InstalledBoardUi> {
  if (options.mode === "static") {
    const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
    installStaticUi(app, moduleDirectory);
    return { async dispose() {} };
  }
  if (options.mode === "vite-dev") {
    const renderer = await installViteDevUi(app, options);
    return {
      async dispose() {
        renderer.dispose();
      },
    };
  }
  return { async dispose() {} };
}
