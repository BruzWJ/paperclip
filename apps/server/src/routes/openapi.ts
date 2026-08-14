import { Router } from "express";
import { registry } from "./openapi-catalog.js";
import { registerOpenApiPaths01 } from "./openapi-paths-01.js";
import { registerOpenApiPaths02 } from "./openapi-paths-02.js";
import { registerOpenApiPaths03 } from "./openapi-paths-03.js";
import { registerOpenApiPaths04 } from "./openapi-paths-04.js";
import { registerOpenApiPaths05 } from "./openapi-paths-05.js";
import { registerOpenApiPaths06 } from "./openapi-paths-06.js";
import { registerOpenApiPaths07 } from "./openapi-paths-07.js";
import { registerOpenApiPaths08 } from "./openapi-paths-08.js";
import { registerOpenApiPaths09 } from "./openapi-paths-09.js";
import { applyDocumentFixups } from "./openapi-security.js";

registerOpenApiPaths01();
registerOpenApiPaths02();
registerOpenApiPaths03();
registerOpenApiPaths04();
registerOpenApiPaths05();
registerOpenApiPaths06();
registerOpenApiPaths07();
registerOpenApiPaths08();
registerOpenApiPaths09();

// ─── Spec builder ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildOpenApiDocument(): any {
  return applyDocumentFixups({
    openapi: "3.0.0",
    info: {
      title: "Paperclip API",
      version: "1.0.0",
      description: "REST API for the Paperclip AI agent management platform",
    },
    servers: [{ url: "/" }],
    components: registry.buildComponents(),
    paths: registry.buildPaths(),
  });
}

export function openApiRoutes() {
  const router = Router({ caseSensitive: true, strict: true });
  router.get("/openapi.json", (_req, res) => {
    res.json(buildOpenApiDocument());
  });
  return router;
}
