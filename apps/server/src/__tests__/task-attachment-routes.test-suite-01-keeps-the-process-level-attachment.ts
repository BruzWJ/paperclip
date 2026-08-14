import * as t from "./task-attachment-routes.test-support.js";
const { describe, it, vi, expect, registerSuiteSetup, createStorageService } = t;
const { mockTaskService, makeAttachment, createApp, request, mockCompanyService } = t;
const { parseBinaryResponse } = t;

describe("normalizeTaskAttachmentMaxBytes", () => {
  it("keeps the process-level attachment cap as the final cap", async () => {
    const previous = process.env.PAPERCLIP_ATTACHMENT_MAX_BYTES;
    process.env.PAPERCLIP_ATTACHMENT_MAX_BYTES = "5";
    vi.resetModules();
    try {
      const { normalizeTaskAttachmentMaxBytes } = await import("../attachment-types.js");
      expect(normalizeTaskAttachmentMaxBytes(null)).toBe(5);
      expect(normalizeTaskAttachmentMaxBytes(10)).toBe(5);
      expect(normalizeTaskAttachmentMaxBytes(3)).toBe(3);
    } finally {
      if (previous === undefined) {
        delete process.env.PAPERCLIP_ATTACHMENT_MAX_BYTES;
      } else {
        process.env.PAPERCLIP_ATTACHMENT_MAX_BYTES = previous;
      }
      vi.resetModules();
    }
  });

  it("rejects a non-canonical process-level attachment cap", async () => {
    const previous = process.env.PAPERCLIP_ATTACHMENT_MAX_BYTES;
    process.env.PAPERCLIP_ATTACHMENT_MAX_BYTES = " 5";
    vi.resetModules();
    try {
      await expect(import("../attachment-types.js")).rejects.toThrow(/PAPERCLIP_ATTACHMENT_MAX_BYTES/);
    } finally {
      if (previous === undefined) {
        delete process.env.PAPERCLIP_ATTACHMENT_MAX_BYTES;
      } else {
        process.env.PAPERCLIP_ATTACHMENT_MAX_BYTES = previous;
      }
      vi.resetModules();
    }
  });
});

describe("task attachment routes", () => {
  registerSuiteSetup();

  it("accepts zip uploads for task attachments", async () => {
    const storage = createStorageService();
    mockTaskService.getById.mockResolvedValue(t.taskFixture());
    mockTaskService.createAttachment.mockResolvedValue(makeAttachment("application/zip", "bundle.zip"));

    const app = await createApp(storage);
    const res = await request(app)
      .post("/api/companies/company-1/tasks/11111111-1111-4111-8111-111111111111/attachments")
      .attach("file", Buffer.from("zip"), {
        filename: "bundle.zip",
        contentType: "application/zip",
      });

    expect([200, 201]).toContain(res.status);
    const putFileCall = storage.__calls.putFile;
    expect(putFileCall).toMatchObject({
      companyId: "company-1",
      namespace: "tasks/11111111-1111-4111-8111-111111111111",
      originalFilename: "bundle.zip",
      contentType: "application/zip",
    });
    expect(Buffer.isBuffer(putFileCall?.body)).toBe(true);
    expect(mockTaskService.createAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "11111111-1111-4111-8111-111111111111",
        contentType: "application/zip",
        originalFilename: "bundle.zip",
      }),
    );
    expect(res.body.contentType).toBe("application/zip");
  }, 15_000);

  it("accepts default video uploads for task attachments", async () => {
    const storage = createStorageService();
    mockTaskService.getById.mockResolvedValue(t.taskFixture());
    mockTaskService.createAttachment.mockResolvedValue(makeAttachment("video/mp4", "clip.mp4"));

    const app = await createApp(storage);
    const res = await request(app)
      .post("/api/companies/company-1/tasks/11111111-1111-4111-8111-111111111111/attachments")
      .attach("file", Buffer.from("mp4"), {
        filename: "clip.mp4",
        contentType: "video/mp4",
      });

    expect(res.status).toBe(201);
    expect(storage.__calls.putFile).toMatchObject({
      contentType: "video/mp4",
      originalFilename: "clip.mp4",
    });
    expect(res.body).toMatchObject({
      contentType: "video/mp4",
      contentPath: "/api/attachments/attachment-1/content",
      openPath: "/api/attachments/attachment-1/content",
      downloadPath: "/api/attachments/attachment-1/content?download=1",
    });
  });

  it("accepts arbitrary upload content types while preserving the stored MIME type", async () => {
    const storage = createStorageService();
    mockTaskService.getById.mockResolvedValue(t.taskFixture());
    mockTaskService.createAttachment.mockResolvedValue(
      makeAttachment("application/x-msdownload", "payload.exe"),
    );

    const app = await createApp(storage);
    const res = await request(app)
      .post("/api/companies/company-1/tasks/11111111-1111-4111-8111-111111111111/attachments")
      .attach("file", Buffer.from("exe"), {
        filename: "payload.exe",
        contentType: "application/x-msdownload",
      });

    expect(res.status).toBe(201);
    expect(storage.__calls.putFile).toMatchObject({
      contentType: "application/x-msdownload",
      originalFilename: "payload.exe",
    });
    expect(mockTaskService.createAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType: "application/x-msdownload",
        originalFilename: "payload.exe",
      }),
    );
    expect(res.body.contentType).toBe("application/x-msdownload");
  });

  it("accepts Office uploads with official MIME types for task attachments", async () => {
    const contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const storage = createStorageService();
    mockTaskService.getById.mockResolvedValue(t.taskFixture());
    mockTaskService.createAttachment.mockResolvedValue(makeAttachment(contentType, "raw-data.xlsx"));

    const app = await createApp(storage);
    const res = await request(app)
      .post("/api/companies/company-1/tasks/11111111-1111-4111-8111-111111111111/attachments")
      .attach("file", Buffer.from("xlsx"), {
        filename: "raw-data.xlsx",
        contentType,
      });

    expect(res.status).toBe(201);
    expect(storage.__calls.putFile).toMatchObject({
      contentType,
      originalFilename: "raw-data.xlsx",
    });
    expect(mockTaskService.createAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType,
        originalFilename: "raw-data.xlsx",
      }),
    );
  });

  it("infers Office MIME types for generic binary task attachment uploads", async () => {
    const contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const storage = createStorageService();
    mockTaskService.getById.mockResolvedValue(t.taskFixture());
    mockTaskService.createAttachment.mockResolvedValue(makeAttachment(contentType, "raw-data.xlsx"));

    const app = await createApp(storage);
    const res = await request(app)
      .post("/api/companies/company-1/tasks/11111111-1111-4111-8111-111111111111/attachments")
      .attach("file", Buffer.from("xlsx"), {
        filename: "raw-data.xlsx",
        contentType: "application/octet-stream",
      });

    expect(res.status).toBe(201);
    expect(storage.__calls.putFile).toMatchObject({
      contentType,
      originalFilename: "raw-data.xlsx",
    });
    expect(mockTaskService.createAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType,
        originalFilename: "raw-data.xlsx",
      }),
    );
  });

  it("preserves generic binary uploads when the filename is not a known Office document", async () => {
    const storage = createStorageService();
    mockTaskService.getById.mockResolvedValue(t.taskFixture());
    mockTaskService.createAttachment.mockResolvedValue(
      makeAttachment("application/octet-stream", "payload.bin"),
    );

    const app = await createApp(storage);
    const res = await request(app)
      .post("/api/companies/company-1/tasks/11111111-1111-4111-8111-111111111111/attachments")
      .attach("file", Buffer.from("bin"), {
        filename: "payload.bin",
        contentType: "application/octet-stream",
      });

    expect(res.status).toBe(201);
    expect(storage.__calls.putFile).toMatchObject({
      contentType: "application/octet-stream",
      originalFilename: "payload.bin",
    });
    expect(mockTaskService.createAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType: "application/octet-stream",
        originalFilename: "payload.bin",
      }),
    );
    expect(res.body.contentType).toBe("application/octet-stream");
  });

  it("enforces the process-level task attachment limit even when the company limit allows more", async () => {
    const storage = createStorageService();
    mockTaskService.getById.mockResolvedValue(t.taskFixture());
    mockTaskService.createAttachment.mockResolvedValue(
      makeAttachment("application/octet-stream", "large.bin"),
    );

    const app = await createApp(storage);
    const res = await request(app)
      .post("/api/companies/company-1/tasks/11111111-1111-4111-8111-111111111111/attachments")
      .attach("file", Buffer.alloc(10 * 1024 * 1024 + 1), {
        filename: "large.bin",
        contentType: "application/octet-stream",
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Attachment exceeds 10485760 bytes");
    expect(storage.__calls.putFile).toBeUndefined();
  });

  it("enforces the configured per-company task attachment limit", async () => {
    const storage = createStorageService();
    mockCompanyService.getById.mockResolvedValue({
      id: "company-1",
      attachmentMaxBytes: 4,
    });
    mockTaskService.getById.mockResolvedValue(t.taskFixture());

    const app = await createApp(storage);
    const res = await request(app)
      .post("/api/companies/company-1/tasks/11111111-1111-4111-8111-111111111111/attachments")
      .attach("file", Buffer.from("large"), {
        filename: "large.txt",
        contentType: "text/plain",
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Attachment exceeds 4 bytes");
    expect(mockTaskService.createAttachment).not.toHaveBeenCalled();
  });

  it("serves html attachments as downloads with nosniff", async () => {
    const storage = createStorageService();
    mockTaskService.getAttachmentById.mockResolvedValue(makeAttachment("text/html", "report.html"));

    const app = await createApp(storage);
    const res = await request(app)
      .get("/api/attachments/attachment-1/content")
      .buffer(true)
      .parse(parseBinaryResponse);

    expect(res.status).toBe(200);
    expect([undefined, 'attachment; filename="report.html"']).toContain(res.headers["content-disposition"]);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("serves arbitrary binary attachments as downloads with nosniff", async () => {
    const storage = createStorageService();
    mockTaskService.getAttachmentById.mockResolvedValue(
      makeAttachment("application/x-msdownload", "payload.exe"),
    );

    const app = await createApp(storage);
    const res = await request(app)
      .get("/api/attachments/attachment-1/content")
      .buffer(true)
      .parse(parseBinaryResponse);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/x-msdownload");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="payload.exe"');
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("keeps image attachments inline for previews", async () => {
    const storage = createStorageService();
    mockTaskService.getAttachmentById.mockResolvedValue(makeAttachment("image/png", "preview.png"));

    const app = await createApp(storage);
    const res = await request(app).get("/api/attachments/attachment-1/content");

    expect(res.status).toBe(200);
    expect([undefined, 'inline; filename="preview.png"']).toContain(res.headers["content-disposition"]);
  });

  it("serves video attachments inline with byte-range support", async () => {
    const storage = createStorageService(Buffer.from("abcdef"));
    mockTaskService.getAttachmentById.mockResolvedValue({
      ...makeAttachment("video/mp4", "clip.mp4"),
      byteSize: 6,
    });

    const app = await createApp(storage);
    const res = await request(app).get("/api/attachments/attachment-1/content").set("Range", "bytes=1-3");

    expect(res.status).toBe(206);
    expect(res.headers["content-type"]).toContain("video/mp4");
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.headers["content-range"]).toBe("bytes 1-3/6");
    expect(res.headers["content-length"]).toBe("3");
    expect(res.headers["content-disposition"]).toBe('inline; filename="clip.mp4"');
    expect(Buffer.from(res.body).toString("utf8")).toBe("bcd");
    expect(storage.getObject).toHaveBeenCalledWith("company-1", "tasks/task-1/clip.mp4", {
      range: { start: 1, end: 3 },
    });
  });

  it("serves mp4 attachments inline when stored with a generic binary content type", async () => {
    const storage = createStorageService(Buffer.from("abcdef"));
    mockTaskService.getAttachmentById.mockResolvedValue({
      ...makeAttachment("application/octet-stream", "clip.mp4"),
      byteSize: 6,
    });

    const app = await createApp(storage);
    const res = await request(app).get("/api/attachments/attachment-1/content").set("Range", "bytes=1-3");

    expect(res.status).toBe(206);
    expect(res.headers["content-type"]).toContain("video/mp4");
    expect(res.headers["content-disposition"]).toBe('inline; filename="clip.mp4"');
    expect(res.headers["content-range"]).toBe("bytes 1-3/6");
    expect(Buffer.from(res.body).toString("utf8")).toBe("bcd");
  });

  it("forces video downloads when the download path is requested", async () => {
    const storage = createStorageService();
    mockTaskService.getAttachmentById.mockResolvedValue(makeAttachment("video/webm", "clip.webm"));

    const app = await createApp(storage);
    const res = await request(app).get("/api/attachments/attachment-1/content?download=1");

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toBe('attachment; filename="clip.webm"');

    const noncanonical = await request(app).get("/api/attachments/attachment-1/content?download=true");
    expect(noncanonical.status).toBe(422);
  });
});
