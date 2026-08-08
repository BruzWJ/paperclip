import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { boardMcpSetupRoutes } from "../routes/board-mcp-setup.js";

function createApp() {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { requestAuthority: unknown }).requestAuthority = {
      scheme: "https",
      hostname: "paperclip.example",
      port: null,
      authority: "paperclip.example",
      origin: "https://paperclip.example",
      immediatePeerTrusted: false,
    };
    next();
  });
  app.use(boardMcpSetupRoutes());
  return app;
}

describe("Board MCP setup route", () => {
  it("serves the copied setup installer for a concrete agent target", async () => {
    await request(createApp())
      .get("/mcp/setup/codex")
      .expect("content-type", /text\/x-shellscript/)
      .expect(200)
      .expect(({ text }) => {
        expect(text).toContain("BASE_URL='https://paperclip.example'");
        expect(text).toContain('TARGETS="codex"');
        expect(text).toContain("/api/cli-auth/challenges");
      });
  });

  it("rejects unknown installer targets", async () => {
    await request(createApp())
      .get("/mcp/setup/not-a-client")
      .expect(404)
      .expect(({ text }) => expect(text).toContain("Unknown MCP installer command"));
  });
});
