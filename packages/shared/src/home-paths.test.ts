import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveDefaultLogsDir,
  resolveDefaultSecretsKeyFilePath,
  resolveDefaultStorageDir,
  resolvePaperclipInstanceConfigPath,
  resolvePaperclipInstanceRoot,
} from "./home-paths.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("home path resolution", () => {
  it("resolves config and runtime data directly under the instance root", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-home-paths-"));
    process.env.PAPERCLIP_HOME = home;
    delete process.env.PAPERCLIP_INSTANCE_ID;

    const instanceRoot = path.join(home, "instances", "default");
    expect(resolvePaperclipInstanceRoot()).toBe(instanceRoot);
    expect(resolvePaperclipInstanceConfigPath()).toBe(path.join(instanceRoot, "config.json"));
    expect(resolveDefaultLogsDir()).toBe(path.join(instanceRoot, "logs"));
    expect(resolveDefaultStorageDir()).toBe(path.join(instanceRoot, "data", "storage"));
    expect(resolveDefaultSecretsKeyFilePath()).toBe(path.join(instanceRoot, "secrets", "master.key"));
  });

  it.each(["", " /tmp/paperclip", "/tmp/paperclip "])(
    "rejects non-exact PAPERCLIP_HOME %j",
    (value) => {
      process.env.PAPERCLIP_HOME = value;
      expect(() => resolvePaperclipInstanceRoot()).toThrow(
        "PAPERCLIP_HOME must be exact and non-empty",
      );
    },
  );
});
