import "./task-attachment-routes.test-suite-01-keeps-the-process-level-attachment.js";
import * as t from "./task-attachment-routes.test-support.js";
const { describe, registerSuiteSetup, it, createStorageService, mockTaskService } = t;
const { makeAttachment, createApp, request, expect, mockAccessService } = t;
const { mockWorkProductService } = t;

describe("task attachment routes", () => {
  registerSuiteSetup();

  it("rejects invalid byte ranges without streaming the object", async () => {
    const storage = createStorageService();
    mockTaskService.getAttachmentById.mockResolvedValue(makeAttachment("video/mp4", "clip.mp4"));

    const app = await createApp(storage);
    const res = await request(app).get("/api/attachments/attachment-1/content").set("Range", "bytes=99-100");

    expect(res.status).toBe(416);
    expect(res.headers["content-range"]).toBe("bytes */4");
    expect(storage.getObject).not.toHaveBeenCalled();
  });

  it("rejects cross-company attachment content reads", async () => {
    const storage = createStorageService();
    mockTaskService.getAttachmentById.mockResolvedValue(makeAttachment("video/mp4", "clip.mp4"));

    const app = await createApp(storage, {
      companyIds: ["company-2"],
      source: "session",
    });
    const res = await request(app).get("/api/attachments/attachment-1/content");

    // Cross-tenant reads return 404 (not 403) so the status code cannot be
    // used as an existence oracle for other tenants' attachment ids.
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Attachment not found");
    expect(storage.getObject).not.toHaveBeenCalled();
  });

  it("allows same-company board attachment reads without a legacy task permission boundary", async () => {
    const storage = createStorageService();
    mockTaskService.getAttachmentById.mockResolvedValue(makeAttachment("video/mp4", "clip.mp4"));
    mockAccessService.decide.mockResolvedValue({
      allowed: false,
      explanation: "Denied by test mock",
    });

    const app = await createApp(storage);
    const res = await request(app).get("/api/attachments/attachment-1/content");

    expect(res.status).toBe(200);
    expect(storage.getObject).toHaveBeenCalled();
  });

  it("canonicalizes paperclip artifact metadata before creating a work product", async () => {
    const storage = createStorageService();
    const task = t.taskFixture({ projectId: null });
    mockTaskService.getById.mockResolvedValue(task);
    mockTaskService.getAttachmentById.mockResolvedValue({
      ...makeAttachment("video/mp4", "clip.mp4"),
      id: "22222222-2222-4222-8222-222222222222",
      byteSize: 6,
      taskId: task.id,
    });
    mockWorkProductService.createForTask.mockResolvedValue({
      id: "work-product-1",
      taskId: task.id,
      companyId: task.companyId,
      type: "artifact",
      provider: "paperclip",
      title: "Clip",
      metadata: null,
    });

    const app = await createApp(storage);
    const res = await request(app)
      .post(`/api/tasks/${task.id}/work-products`)
      .send({
        type: "artifact",
        provider: "paperclip",
        title: "Clip",
        metadata: {
          attachmentId: "22222222-2222-4222-8222-222222222222",
          contentType: "video/mp4",
          byteSize: 6,
          contentPath: "https://evil.example/clip.mp4",
          openPath: "javascript:alert(1)",
          downloadPath: "javascript:alert(2)",
          originalFilename: "clip.mp4",
        },
      });

    expect(res.status).toBe(201);
    expect(mockWorkProductService.createForTask).toHaveBeenCalledWith(
      task.id,
      task.companyId,
      expect.objectContaining({
        type: "artifact",
        provider: "paperclip",
        metadata: {
          attachmentId: "22222222-2222-4222-8222-222222222222",
          contentType: "video/mp4",
          byteSize: 6,
          contentPath: "/api/attachments/22222222-2222-4222-8222-222222222222/content",
          openPath: "/api/attachments/22222222-2222-4222-8222-222222222222/content",
          downloadPath: "/api/attachments/22222222-2222-4222-8222-222222222222/content?download=1",
          originalFilename: "clip.mp4",
        },
      }),
    );
  });

  it("rejects paperclip artifact metadata that references another task's attachment", async () => {
    const storage = createStorageService();
    const task = t.taskFixture({ projectId: null });
    mockTaskService.getById.mockResolvedValue(task);
    mockTaskService.getAttachmentById.mockResolvedValue({
      ...makeAttachment("video/mp4", "clip.mp4"),
      id: "22222222-2222-4222-8222-222222222222",
      taskId: "different-task",
    });

    const app = await createApp(storage);
    const res = await request(app)
      .post(`/api/tasks/${task.id}/work-products`)
      .send({
        type: "artifact",
        provider: "paperclip",
        title: "Clip",
        metadata: {
          attachmentId: "22222222-2222-4222-8222-222222222222",
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Attachment artifact must reference an attachment on the same task");
    expect(mockWorkProductService.createForTask).not.toHaveBeenCalled();
  });

  it("canonicalizes paperclip artifact metadata on work product updates", async () => {
    const storage = createStorageService();
    const task = t.taskFixture({ projectId: null });
    mockWorkProductService.getById.mockResolvedValue({
      id: "work-product-1",
      taskId: task.id,
      companyId: task.companyId,
      type: "artifact",
      provider: "paperclip",
      title: "Clip",
      metadata: null,
    });
    mockTaskService.getById.mockResolvedValue(task);
    mockTaskService.getAttachmentById.mockResolvedValue({
      ...makeAttachment("video/webm", "clip.webm"),
      id: "22222222-2222-4222-8222-222222222222",
      taskId: task.id,
      byteSize: 8,
    });
    mockWorkProductService.update.mockResolvedValue({
      id: "work-product-1",
      taskId: task.id,
      companyId: task.companyId,
      type: "artifact",
      provider: "paperclip",
      title: "Clip",
      metadata: null,
    });

    const app = await createApp(storage);
    const res = await request(app)
      .patch("/api/work-products/work-product-1")
      .send({
        metadata: {
          attachmentId: "22222222-2222-4222-8222-222222222222",
          openPath: "javascript:alert(1)",
        },
      });

    expect(res.status).toBe(200);
    expect(mockWorkProductService.update).toHaveBeenCalledWith(
      "work-product-1",
      expect.objectContaining({
        metadata: {
          attachmentId: "22222222-2222-4222-8222-222222222222",
          contentType: "video/webm",
          byteSize: 8,
          contentPath: "/api/attachments/22222222-2222-4222-8222-222222222222/content",
          openPath: "/api/attachments/22222222-2222-4222-8222-222222222222/content",
          downloadPath: "/api/attachments/22222222-2222-4222-8222-222222222222/content?download=1",
          originalFilename: "clip.webm",
        },
      }),
    );
  });
});
