import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultClientContext,
  readContext,
  setCurrentProfile,
  upsertProfile,
  writeContext,
} from "../client/context.js";

function createTempContextPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-cli-context-"));
  return path.join(dir, "context.json");
}

const COMPANY_ID = "abcdef12-3456-4789-8abc-def012345678";

describe("client context store", () => {
  it("returns default context when file does not exist", () => {
    const contextPath = createTempContextPath();
    const context = readContext(contextPath);
    expect(context).toEqual(defaultClientContext());
  });

  it("upserts profile values and switches current profile", () => {
    const contextPath = createTempContextPath();

    upsertProfile(
      "work",
      {
        apiBase: "http://localhost:3100",
        companyId: COMPANY_ID,
        apiKeyEnvVarName: "PAPERCLIP_BOARD_TOKEN",
      },
      contextPath,
    );

    setCurrentProfile("work", contextPath);
    const context = readContext(contextPath);

    expect(context.currentProfile).toBe("work");
    expect(context.profiles.work).toEqual({
      apiBase: "http://localhost:3100",
      companyId: COMPANY_ID,
      apiKeyEnvVarName: "PAPERCLIP_BOARD_TOKEN",
    });
  });

  it("preserves existing profile values when patch fields are undefined", () => {
    const contextPath = createTempContextPath();

    upsertProfile(
      "default",
      {
        apiBase: "http://127.0.0.1:3197",
      },
      contextPath,
    );

    upsertProfile(
      "default",
      {
        apiBase: undefined,
        companyId: COMPANY_ID,
      },
      contextPath,
    );

    const context = readContext(contextPath);
    expect(context.profiles.default).toEqual({
      apiBase: "http://127.0.0.1:3197",
      companyId: COMPANY_ID,
    });
  });

  it("rejects retired context versions and fields", () => {
    const contextPath = createTempContextPath();
    fs.writeFileSync(
      contextPath,
      JSON.stringify({
        version: 1,
        currentProfile: "legacy",
        profiles: {
          legacy: {
            apiBase: "http://localhost:3101",
            companyId: COMPANY_ID,
            persona: "board",
            apiKeyEnvVarName: "PAPERCLIP_BOARD_TOKEN",
          },
        },
      }),
    );

    expect(() => readContext(contextPath)).toThrow(/version must be exactly 2/);
  });

  it("rejects blank profile fields instead of silently dropping them", () => {
    const contextPath = createTempContextPath();
    expect(() =>
      writeContext(
        {
          version: 2,
          currentProfile: "x",
          profiles: { x: { apiBase: " ", apiKeyEnvVarName: " " } },
        },
        contextPath,
      ),
    ).toThrow(/must be exact and non-empty/);
  });

  it("rejects an invalid stored company ID without normalizing it", () => {
    const contextPath = createTempContextPath();
    for (const companyId of [` ${COMPANY_ID}`, COMPANY_ID.toUpperCase()]) {
      fs.writeFileSync(
        contextPath,
        JSON.stringify({
          version: 2,
          currentProfile: "x",
          profiles: { x: { companyId } },
        }),
      );
      expect(() => readContext(contextPath)).toThrow(
        /exact canonical company UUID/,
      );
    }
  });

  it("rejects an invalid company ID before writing a profile", () => {
    const contextPath = createTempContextPath();
    expect(() =>
      upsertProfile("x", { companyId: "company-123" }, contextPath),
    ).toThrow(/exact canonical company UUID/);
  });
});
