import { beforeEach, describe, expect, it, vi } from "vitest";

const aws = vi.hoisted(() => ({
  send: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", async () => {
  const actual =
    await vi.importActual<typeof import("@aws-sdk/client-s3")>(
      "@aws-sdk/client-s3",
    );
  return {
    ...actual,
    S3Client: class {
      send(command: unknown) {
        return aws.send(command);
      }
    },
  };
});

import { createS3StorageProvider } from "../storage/s3-provider.js";

describe("S3 storage provider object keys", () => {
  beforeEach(() => {
    aws.send.mockReset();
  });

  it.each([" root", "root ", "/root", "root/", "root//assets", "root\\assets"])(
    "rejects noncanonical S3 prefix %j instead of normalizing it",
    (prefix) => {
      expect(() =>
        createS3StorageProvider({
          bucket: "paperclip",
          region: "us-east-1",
          prefix,
        }),
      ).toThrow(expect.objectContaining({ status: 422 }));
    },
  );

  it.each([
    { bucket: " paperclip", region: "us-east-1" },
    { bucket: "paperclip", region: "us-east-1 " },
  ])("rejects padded S3 identity %#", (config) => {
    expect(() => createS3StorageProvider(config)).toThrow(
      expect.objectContaining({ status: 422 }),
    );
  });

  it.each([
    "",
    " https://s3.example.test",
    "https://S3.example.test",
    "https://s3.example.test/",
    "https://s3.example.test/path",
    "https://s3.example.test:443",
  ])("rejects noncanonical S3 endpoint %j", (endpoint) => {
    expect(() =>
      createS3StorageProvider({
        bucket: "paperclip",
        region: "us-east-1",
        endpoint,
      }),
    ).toThrow(expect.objectContaining({ status: 422 }));
  });

  it("passes an exact object key to S3 without rewriting it", async () => {
    aws.send.mockResolvedValueOnce({ ContentLength: 5 });
    const provider = createS3StorageProvider({
      bucket: "paperclip",
      region: "us-east-1",
      prefix: "production/assets",
    });

    await provider.headObject({
      objectKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/tasks/file.png",
    });

    const command = aws.send.mock.calls[0]?.[0] as { input: { Key: string } };
    expect(command.input.Key).toBe(
      "production/assets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/tasks/file.png",
    );
  });

  it.each([
    "",
    "company\\assets\\file.png",
    "company/assets//file.png",
    "company/assets/",
    "company/./file.png",
    "company/../file.png",
    "company/assets/file name.png",
  ])(
    "rejects noncanonical object key %j before calling S3",
    async (objectKey) => {
      const provider = createS3StorageProvider({
        bucket: "paperclip",
        region: "us-east-1",
      });

      await expect(provider.headObject({ objectKey })).rejects.toMatchObject({
        status: 400,
      });
      expect(aws.send).not.toHaveBeenCalled();
    },
  );
});
