import { afterEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";

const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_COMPANY_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function readStreamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe("local disk storage provider", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  it("round-trips bytes through storage service", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-storage-"));
    tempRoots.push(root);

    const service = createStorageService(createLocalDiskStorageProvider(root));
    const content = Buffer.from("hello image bytes", "utf8");
    const stored = await service.putFile({
      companyId: COMPANY_ID,
      namespace: "tasks/task-1",
      originalFilename: "demo.png",
      contentType: "image/png",
      body: content,
    });

    const fetched = await service.getObject(COMPANY_ID, stored.objectKey);
    const fetchedBody = await readStreamToBuffer(fetched.stream);

    expect(fetchedBody.toString("utf8")).toBe("hello image bytes");
    expect(stored.sha256).toHaveLength(64);
  });

  it("streams only requested byte ranges", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-storage-"));
    tempRoots.push(root);

    const service = createStorageService(createLocalDiskStorageProvider(root));
    const stored = await service.putFile({
      companyId: COMPANY_ID,
      namespace: "tasks/task-1",
      originalFilename: "demo.mp4",
      contentType: "video/mp4",
      body: Buffer.from("0123456789", "utf8"),
    });

    const fetched = await service.getObject(COMPANY_ID, stored.objectKey, { range: { start: 2, end: 5 } });
    const fetchedBody = await readStreamToBuffer(fetched.stream);

    expect(fetchedBody.toString("utf8")).toBe("2345");
    expect(fetched.contentLength).toBe(4);
  });

  it("blocks cross-company object access", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-storage-"));
    tempRoots.push(root);

    const service = createStorageService(createLocalDiskStorageProvider(root));
    const stored = await service.putFile({
      companyId: COMPANY_ID,
      namespace: "tasks/task-1",
      originalFilename: "demo.png",
      contentType: "image/png",
      body: Buffer.from("hello", "utf8"),
    });

    await expect(service.getObject(OTHER_COMPANY_ID, stored.objectKey)).rejects.toMatchObject({ status: 403 });
  });

  it("delete is idempotent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-storage-"));
    tempRoots.push(root);

    const service = createStorageService(createLocalDiskStorageProvider(root));
    const stored = await service.putFile({
      companyId: COMPANY_ID,
      namespace: "tasks/task-1",
      originalFilename: "demo.png",
      contentType: "image/png",
      body: Buffer.from("hello", "utf8"),
    });

    await service.deleteObject(COMPANY_ID, stored.objectKey);
    await service.deleteObject(COMPANY_ID, stored.objectKey);
    await expect(service.getObject(COMPANY_ID, stored.objectKey)).rejects.toMatchObject({ status: 404 });
  });

  it("rejects noncanonical company identity aliases", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-storage-"));
    tempRoots.push(root);
    const service = createStorageService(createLocalDiskStorageProvider(root));

    await expect(service.putFile({
      companyId: ` ${COMPANY_ID} `,
      namespace: "tasks",
      originalFilename: "demo.png",
      contentType: "image/png",
      body: Buffer.from("hello", "utf8"),
    })).rejects.toMatchObject({ status: 422 });
    await expect(service.getObject(COMPANY_ID.toUpperCase(), `${COMPANY_ID}/file`))
      .rejects.toMatchObject({ status: 422 });
  });

  it("rejects namespace and content-type aliases", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-storage-"));
    tempRoots.push(root);
    const service = createStorageService(createLocalDiskStorageProvider(root));
    const input = {
      companyId: COMPANY_ID,
      originalFilename: "demo.png",
      body: Buffer.from("hello", "utf8"),
    };

    await expect(service.putFile({
      ...input,
      namespace: " tasks//task ",
      contentType: "image/png",
    })).rejects.toMatchObject({ status: 422 });
    await expect(service.putFile({
      ...input,
      namespace: "tasks",
      contentType: " Image/PNG ",
    })).rejects.toMatchObject({ status: 422 });
  });

  it.each([
    "",
    `${COMPANY_ID}\\assets\\file.png`,
    `${COMPANY_ID}/assets//file.png`,
    `${COMPANY_ID}/assets/`,
    `${COMPANY_ID}/./file.png`,
    `${COMPANY_ID}/../file.png`,
    `${COMPANY_ID}/assets/file name.png`,
    ` ${COMPANY_ID}/assets/file.png`,
  ])("rejects noncanonical object key %j at the service boundary", async (objectKey) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-storage-"));
    tempRoots.push(root);
    const service = createStorageService(createLocalDiskStorageProvider(root));

    await expect(service.headObject(COMPANY_ID, objectKey)).rejects.toMatchObject({ status: 400 });
  });

  it("rejects object-key aliases instead of rewriting them in the local provider", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-storage-"));
    tempRoots.push(root);
    const provider = createLocalDiskStorageProvider(root);
    const input = {
      objectKey: "assets\\company//logo.png ",
      body: Buffer.from("hello", "utf8"),
      contentType: "image/png",
      contentLength: 5,
    };

    await expect(provider.putObject(input)).rejects.toMatchObject({ status: 400 });
    expect(await fs.readdir(root)).toEqual([]);
  });
});
