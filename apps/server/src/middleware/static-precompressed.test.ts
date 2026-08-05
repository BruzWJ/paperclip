import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { staticPrecompressed } from "./static-precompressed.js";

const PLAIN_JS = "console.log('plain variant');";
const BR_JS = "console.log('brotli variant');";
const GZ_JS = "console.log('gzip variant');";
const SECRET = "TOP-SECRET-DO-NOT-SERVE";
const EXPECTED_CACHE_CONTROL = "public, max-age=31536000, immutable";

let tempDir: string;
let assetsDir: string;
let app: express.Express;

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "static-precompressed-"));
  assetsDir = path.join(tempDir, "assets");
  await mkdir(assetsDir, { recursive: true });

  await writeFile(path.join(assetsDir, "app.js"), PLAIN_JS);
  await writeFile(path.join(assetsDir, "app.js.br"), brotliCompressSync(Buffer.from(BR_JS)));
  await writeFile(path.join(assetsDir, "app.js.gz"), gzipSync(Buffer.from(GZ_JS)));
  // No sidecars for this one: must fall through to express.static.
  await writeFile(path.join(assetsDir, "loose.js"), "console.log('loose');");
  // Outside the assets root: must never be reachable via traversal.
  await writeFile(path.join(tempDir, "secret.txt"), SECRET);

  app = express();
  app.use("/assets", staticPrecompressed(assetsDir), express.static(assetsDir));
  app.use((_req, res) => {
    res.status(404).send("fell-through");
  });
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("staticPrecompressed", () => {
  it("serves the brotli sidecar when br and gzip are both acceptable", async () => {
    const res = await request(app)
      .get("/assets/app.js")
      .set("Accept-Encoding", "br,gzip");

    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("br");
    expect(res.headers["content-type"]).toMatch(/^text\/javascript/);
    expect(res.headers["vary"]).toBe("Accept-Encoding");
    expect(res.headers["cache-control"]).toBe(EXPECTED_CACHE_CONTROL);
    expect(res.text).toBe(BR_JS);
  });

  it("serves the gzip sidecar when only gzip is acceptable", async () => {
    const res = await request(app)
      .get("/assets/app.js")
      .set("Accept-Encoding", "gzip");

    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(res.headers["content-type"]).toMatch(/^text\/javascript/);
    expect(res.headers["vary"]).toBe("Accept-Encoding");
    expect(res.headers["cache-control"]).toBe(EXPECTED_CACHE_CONTROL);
    expect(res.text).toBe(GZ_JS);
  });

  it("serves the plain file when Accept-Encoding is identity", async () => {
    const res = await request(app)
      .get("/assets/app.js")
      .set("Accept-Encoding", "identity");

    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.text).toBe(PLAIN_JS);
  });

  it("serves the plain file when both encodings are explicitly forbidden", async () => {
    const res = await request(app)
      .get("/assets/app.js")
      .set("Accept-Encoding", "gzip;q=0,br;q=0");

    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.text).toBe(PLAIN_JS);
  });

  it("does not serve an encoding forbidden with q=0 even under a wildcard", async () => {
    const res = await request(app)
      .get("/assets/app.js")
      .set("Accept-Encoding", "br;q=0, *");

    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(res.text).toBe(GZ_JS);
  });

  it("falls through to express.static when no sidecar exists", async () => {
    const res = await request(app)
      .get("/assets/loose.js")
      .set("Accept-Encoding", "br,gzip");

    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.text).toBe("console.log('loose');");
  });

  it("does not let a plain traversal path escape the root", async () => {
    const res = await request(app)
      .get("/assets/../secret.txt")
      .set("Accept-Encoding", "br,gzip");

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.text).not.toContain(SECRET);
  });

  it("does not let a percent-encoded traversal path escape the root", async () => {
    const res = await request(app)
      .get("/assets/%2e%2e/secret.txt")
      .set("Accept-Encoding", "br,gzip");

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.text).not.toContain(SECRET);
  });

  it("answers HEAD requests with headers and no body", async () => {
    const res = await request(app)
      .head("/assets/app.js")
      .set("Accept-Encoding", "br,gzip");

    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("br");
    expect(res.headers["content-type"]).toMatch(/^text\/javascript/);
    expect(res.headers["vary"]).toBe("Accept-Encoding");
    expect(res.headers["cache-control"]).toBe(EXPECTED_CACHE_CONTROL);
    expect(res.text).toBeFalsy();
  });
});
