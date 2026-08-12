import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAdapterCommands } from "../commands/client/adapter.js";
import { registerAssetCommands } from "../commands/client/asset.js";
import {
  registerCompanyCommands,
  resolveExportOutputPath,
} from "../commands/client/company.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const ASSET_ID = "44444444-4444-4444-8444-444444444444";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerCompanyCommands(program);
  registerAdapterCommands(program);
  registerAssetCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync(
    [
      ...args,
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "board-token",
    ],
    { from: "user" },
  );
}

describe("admin and asset parity commands", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_BOARD_API_KEY;
    delete process.env.PAPERCLIP_BOARD_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    tempDir = await mkdtemp(path.join(tmpdir(), "paperclip-cli-parity-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("wraps company management and raw portability endpoints", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run(["company", "stats"]);
    await run(["company", "create", "--payload-json", "{}"]);
    await run(["company", "update", COMPANY_ID, "--payload-json", "{}"]);
    await run([
      "company",
      "branding:update",
      COMPANY_ID,
      "--payload-json",
      "{}",
    ]);
    await run(["company", "archive", COMPANY_ID]);
    await run([
      "company",
      "export:preview",
      COMPANY_ID,
      "--payload-json",
      "{}",
    ]);
    await run(["company", "export:api", COMPANY_ID, "--payload-json", "{}"]);
    await run([
      "company",
      "import:preview",
      COMPANY_ID,
      "--payload-json",
      "{}",
    ]);
    await run(["company", "import:apply", COMPANY_ID, "--payload-json", "{}"]);

    expect(
      fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]]),
    ).toEqual([
      ["GET", "http://localhost:3100/api/companies/stats"],
      ["POST", "http://localhost:3100/api/companies"],
      ["PATCH", `http://localhost:3100/api/companies/${COMPANY_ID}`],
      ["PATCH", `http://localhost:3100/api/companies/${COMPANY_ID}/branding`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/archive`],
      [
        "POST",
        `http://localhost:3100/api/companies/${COMPANY_ID}/exports/preview`,
      ],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/exports`],
      [
        "POST",
        `http://localhost:3100/api/companies/${COMPANY_ID}/imports/preview`,
      ],
      [
        "POST",
        `http://localhost:3100/api/companies/${COMPANY_ID}/imports/apply`,
      ],
    ]);
  });

  it("registers only ACPX discovery commands", () => {
    const adapter = createProgram().commands.find(
      (command) => command.name() === "adapter",
    );

    expect(adapter?.commands.map((command) => command.name())).toEqual([
      "list",
    ]);
  });

  it("wraps the sole ACPX catalog endpoint", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run(["adapter", "list"]);

    expect(
      fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]]),
    ).toEqual([["GET", "http://localhost:3100/api/adapters"]]);
  });

  it("wraps asset upload/download endpoints", async () => {
    const imagePath = path.join(tempDir, "logo.png");
    const outputPath = path.join(tempDir, "asset.bin");
    await writeFile(imagePath, Buffer.from("png"));
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve(jsonResponse({ assetId: ASSET_ID }, { status: 201 })),
      )
      .mockImplementationOnce(() =>
        Promise.resolve(jsonResponse({ assetId: ASSET_ID }, { status: 201 })),
      )
      .mockImplementationOnce(() =>
        Promise.resolve(new Response("asset-bytes")),
      );
    vi.stubGlobal("fetch", fetchMock);

    await run([
      "asset",
      "image:upload",
      "--company-id",
      COMPANY_ID,
      "--file",
      imagePath,
      "--namespace",
      "docs",
      "--alt",
      "Logo",
    ]);
    await run([
      "asset",
      "logo:upload",
      "--company-id",
      COMPANY_ID,
      "--file",
      imagePath,
    ]);
    await run(["asset", "content", ASSET_ID, "--out", outputPath]);

    expect(
      fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]]),
    ).toEqual([
      [
        "POST",
        `http://localhost:3100/api/companies/${COMPANY_ID}/assets/images`,
      ],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/logo`],
      ["GET", `http://localhost:3100/api/assets/${ASSET_ID}/content`],
    ]);
    const firstUpload = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect((firstUpload.get("file") as File).type).toBe("image/png");
  });

  it("rejects portable export paths outside the output directory", async () => {
    expect(() => resolveExportOutputPath(tempDir, "../outside.md")).toThrow(
      "outside output directory",
    );
  });
});

function jsonResponse(
  body: unknown = { ok: true },
  init: ResponseInit = { status: 200 },
): Response {
  return new Response(JSON.stringify(body), init);
}
