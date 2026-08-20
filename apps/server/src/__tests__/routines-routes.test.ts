import * as t from "./routines-routes.test-support.js";
const { describe, it, createBoardApp, companyId, projectId, request } = t;
const { expect, mockRoutineService, routineId, revisionId, mockAnnotationService } = t;
const { mockLogActivity, trigger, agentId } = t;
const { mockTrackRoutineCreated } = t;
import { registerSuiteSetup } from "./routines-routes.test-setup-01.js";

describe("routine routes", () => {
  registerSuiteSetup();

  it("passes project filters to the routine list service", async () => {
    const app = await createBoardApp("admin");

    const res = await request(app).get(`/api/companies/${companyId}/routines`).query({ projectId });

    expect(res.status).toBe(200);
    expect(mockRoutineService.list).toHaveBeenCalledWith(companyId, {
      projectId,
    });
  });

  it("lists routine revisions for a board member in newest-first service order", async () => {
    const app = await createBoardApp("admin");

    const res = await request(app).get(`/api/routines/${routineId}/revisions`);

    expect(res.status).toBe(200);
    expect(mockRoutineService.listRevisions).toHaveBeenCalledWith(routineId);
    expect(res.body[0]).toMatchObject({ id: revisionId, revisionNumber: 1 });
  });

  it("creates, replies to, and resolves routine description annotation threads", async () => {
    const app = await createBoardApp("admin");

    const selector = {
      quote: { exact: "selected text", prefix: "Alpha ", suffix: " omega" },
      position: {
        normalizedStart: 6,
        normalizedEnd: 19,
        markdownStart: 6,
        markdownEnd: 19,
      },
    };

    const created = await request(app)
      .post(`/api/routines/${routineId}/description/annotations`)
      .send({
        baseRevisionId: revisionId,
        baseRevisionNumber: 1,
        selector,
        body: "Please review",
      })
      .expect(201);

    expect(created.body).toMatchObject({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      routineId,
      taskId: null,
      documentKey: "description",
    });
    expect(mockAnnotationService.createRoutineThread).toHaveBeenCalledWith(
      routineId,
      "description",
      expect.objectContaining({ body: "Please review" }),
      expect.objectContaining({
        actorType: "user",
        userId: "board-user",
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "routine.document_annotation_thread_created",
        entityType: "routine",
        entityId: routineId,
        details: expect.objectContaining({
          documentKey: "description",
        }),
      }),
    );

    await request(app)
      .post(`/api/routines/${routineId}/description/annotations/${created.body.id}/comments`)
      .send({ body: "Reply" })
      .expect(201);
    expect(mockAnnotationService.addRoutineComment).toHaveBeenCalledWith(
      routineId,
      "description",
      created.body.id,
      expect.objectContaining({ body: "Reply" }),
      expect.objectContaining({
        actorType: "user",
        userId: "board-user",
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "routine.document_annotation_comment_added",
        entityType: "routine",
        entityId: routineId,
      }),
    );

    const resolved = await request(app)
      .patch(`/api/routines/${routineId}/description/annotations/${created.body.id}`)
      .send({ status: "resolved" })
      .expect(200);

    expect(resolved.body.status).toBe("resolved");
    expect(mockAnnotationService.updateRoutineThread).toHaveBeenCalledWith(
      routineId,
      "description",
      created.body.id,
      expect.objectContaining({ status: "resolved" }),
      expect.objectContaining({
        actorType: "user",
        userId: "board-user",
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "routine.document_annotation_thread_resolved",
        entityType: "routine",
        entityId: routineId,
      }),
    );
  });

  it("blocks routine revision reads across company scope", async () => {
    const app = await createBoardApp("operator", "99999999-9999-4999-8999-999999999999");

    const res = await request(app).get(`/api/routines/${routineId}/revisions`);

    expect(res.status).toBe(404);
    expect(mockRoutineService.listRevisions).not.toHaveBeenCalled();
  });

  it("returns an identical 404 body for missing and cross-tenant routine triggers", async () => {
    const crossTenantApp = await createBoardApp("operator", "99999999-9999-4999-8999-999999999999");
    const crossTenant = await request(crossTenantApp)
      .patch(`/api/routine-triggers/${trigger.id}`)
      .send({ kind: "cron", config: { expression: "0 9 * * *" } });

    mockRoutineService.getTrigger.mockResolvedValue(null);
    const missing = await request(crossTenantApp)
      .patch(`/api/routine-triggers/${trigger.id}`)
      .send({ kind: "cron", config: { expression: "0 9 * * *" } });

    expect(crossTenant.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(crossTenant.body).toEqual(missing.body);
    expect(mockRoutineService.updateTrigger).not.toHaveBeenCalled();
  });

  it("lets an active viewer run a routine as the Board user", async () => {
    const app = await createBoardApp("viewer");

    const res = await request(app).post(`/api/routines/${routineId}/run`).send({});

    expect(res.status).toBe(202);
    expect(mockRoutineService.runRoutine).toHaveBeenCalledWith(
      routineId,
      {
        source: "manual",
      },
      {
        type: "user",
        userId: "board-user",
      },
    );
  });

  it("lets an active viewer create a routine with Board task-mutation authority", async () => {
    const app = await createBoardApp("viewer");

    const res = await request(app).post(`/api/companies/${companyId}/routines`).send({
      projectId,
      title: "Daily routine",
      assigneeAgentId: agentId,
    });

    expect(res.status).toBe(201);
    expect(mockRoutineService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        projectId,
        title: "Daily routine",
        assigneeAgentId: agentId,
      }),
      {
        type: "user",
        userId: "board-user",
      },
    );
    expect(mockTrackRoutineCreated).toHaveBeenCalledWith(expect.anything());
  });
});
