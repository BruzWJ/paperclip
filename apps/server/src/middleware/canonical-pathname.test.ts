import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { canonicalRequestTarget } from "./canonical-pathname.js";

function buildApp() {
  const app = express();
  app.use("/api", canonicalRequestTarget());
  app.use("/_plugins", canonicalRequestTarget());
  app.get("/api/items/:itemId", (req, res) => {
    res.json({ itemId: req.params.itemId });
  });
  app.get("/@vite/client", (_req, res) => {
    res.status(204).end();
  });
  return app;
}

describe("canonicalRequestTarget", () => {
  it("admits the sole literal spelling and preserves query strings", async () => {
    await request(buildApp())
      .get("/api/items/abc?view=all")
      .expect(200, { itemId: "abc" });
  });

  it.each([
    "/api/items/abc?item%49d=abc",
    "/api/items/abc?itemId=%61bc",
    "/api/items/abc?q=a%20b",
  ])(
    "rejects the raw query alias %s before Express decodes it",
    async (url) => {
      const response = await request(buildApp()).get(url).expect(404);
      expect(response.body).toEqual({ error: "Not found" });
    },
  );

  it.each(["/api/items/%61bc", "/api/items/%2F", "/api/items/%7c"])(
    "rejects the raw path alias %s before Express decodes it",
    async (pathname) => {
      const response = await request(buildApp()).get(pathname).expect(404);
      expect(response.body).toEqual({ error: "Not found" });
    },
  );

  it("does not apply the identity-route guard to Vite infrastructure paths", async () => {
    await request(buildApp()).get("/@vite/client").expect(204);
  });
});
