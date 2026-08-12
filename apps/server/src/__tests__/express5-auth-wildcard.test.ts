import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

/**
 * Regression test for paperclipai/paperclip#2898.
 *
 * Express 5 (path-to-regexp v8+) dropped support for the `*paramName`
 * wildcard syntax used in Express 4. Routes declared with the old syntax
 * silently fail to match, causing every `/api/auth/*` request to fall
 * through and return 404.
 *
 * The correct Express 5 syntax for a named catch-all is `{*paramName}`.
 * These tests verify that the better-auth handler is invoked for both
 * shallow and deep auth sub-paths.
 */
describe("Express 5 /api/auth wildcard route", () => {
  function buildApp() {
    const app = express();
    app.set("case sensitive routing", true);
    app.set("strict routing", true);
    let callCount = 0;
    const handler = (_req: express.Request, res: express.Response) => {
      callCount += 1;
      res.status(200).json({ ok: true });
    };
    app.all("/api/auth/{*authPath}", handler);
    return {
      app,
      getCallCount: () => callCount,
    };
  }

  it("matches auth sub-paths without matching unrelated API paths", async () => {
    const { app, getCallCount } = buildApp();

    await expect(request(app).post("/api/auth/sign-in/email")).resolves.toMatchObject({
      status: 200,
    });
    await expect(request(app).get("/api/auth/callback/credentials/sign-in")).resolves.toMatchObject({
      status: 200,
    });
    expect(getCallCount()).toBe(2);

    await expect(request(app).get("/api/other/endpoint")).resolves.toMatchObject({
      status: 404,
    });
    expect(getCallCount()).toBe(2);

    await expect(request(app).post("/api/auth/sign-out")).resolves.toMatchObject({
      status: 200,
    });
    await expect(request(app).get("/api/auth/session")).resolves.toMatchObject({
      status: 200,
    });
    expect(getCallCount()).toBe(4);
  });
});

describe("canonical Express routing", () => {
  it("rejects route case and trailing-slash aliases", async () => {
    const app = express();
    app.set("case sensitive routing", true);
    app.set("strict routing", true);
    const api = express.Router({ caseSensitive: true, strict: true });
    api.get("/things", (_req, res) => res.sendStatus(204));
    app.use("/api", api);

    await expect(request(app).get("/api/things")).resolves.toMatchObject({
      status: 204,
    });
    for (const alias of ["/api/things/", "/api/Things", "/API/things"]) {
      await expect(request(app).get(alias)).resolves.toMatchObject({
        status: 404,
      });
    }
  });

  it("keeps every production API router strict and case-sensitive", () => {
    const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const files = [
      join(sourceRoot, "app.ts"),
      ...readdirSync(join(sourceRoot, "routes"), {
        recursive: true,
        encoding: "utf8",
      })
        .filter((entry) => entry.endsWith(".ts"))
        .map((entry) => join(sourceRoot, "routes", entry)),
    ];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/\bRouter\(\)/);
      for (const match of source.matchAll(/\bRouter\(([^)]*)\)/g)) {
        expect(match[1]).toContain("caseSensitive: true");
        expect(match[1]).toContain("strict: true");
      }
    }
  });
});
