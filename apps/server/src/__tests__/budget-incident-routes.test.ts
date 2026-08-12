import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { costRoutes } from "../routes/costs.js";
import { createMockDb } from "./helpers/mock-db.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const uppercaseIncidentId = "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF";

describe("budget incident routes", () => {
  it("returns not found for a noncanonical UUID alias without querying the database", async () => {
    const { db, calls } = createMockDb();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = testBoardSessionActor({
        userId: "board-user",
        companyIds: [companyId],
      });
      next();
    });
    app.use(
      "/api",
      costRoutes(db, {
        taskExecutionCancellation: {
          suspendBudgetScopeWork: vi.fn(),
        },
      }),
    );
    app.use(errorHandler);

    const response = await request(app)
      .post(
        `/api/companies/${companyId}/budget-incidents/${uppercaseIncidentId}/resolve`,
      )
      .send({ action: "keep_paused" });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Budget incident not found" });
    expect(calls).toEqual([]);
  });
});
