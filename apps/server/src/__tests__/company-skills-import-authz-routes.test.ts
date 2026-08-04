import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createMockDb } from "./helpers/mock-db.js";
import { errorHandler } from "../middleware/error-handler.js";
import { companySkillRoutes } from "../routes/company-skills.js";
import { denyGenericAgentRest } from "../routes/compiled-interface-only.js";

describe("company skill import authorization routes", () => {
  it("denies generic agent REST imports even with delegated agent authority", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const responsibleUserId = `user-${randomUUID()}`;
    const harness = createMockDb();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        companyId,
        agentId,
        runId,
        source: "internal",
        onBehalfOfUserId: responsibleUserId,
        onBehalfOfMemberships: [{
          companyId,
          membershipRole: "operator",
          status: "active",
        }],
      };
      next();
    });
    app.use("/api", denyGenericAgentRest("REST"));
    app.use("/api", companySkillRoutes(harness.db, {
      ordinaryIssues: {} as never,
      issueExecutionCancellation: {
        cancelRun: async () => null,
      },
    }));
    app.use(errorHandler);

    const response = await request(app)
      .post(`/api/companies/${companyId}/skills/import`)
      .send({ source: "/approved/workspace/skills/import-authz-fixture" });

    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.code).toBe("compiled_run_interface_required");
    expect(harness.calls).toEqual([]);
  });
});
