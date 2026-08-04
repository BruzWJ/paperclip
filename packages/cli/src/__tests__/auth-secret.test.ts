import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { provisionPrimaryBetterAuthSecret } from "../config/auth-secret.js";
import { readPaperclipEnvEntries } from "../config/env.js";

const roots: string[] = [];

function configPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-auth-secret-"));
  roots.push(root);
  return path.join(root, "config.json");
}

afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe("primary Better Auth secret provisioning", () => {
  it("generates and persists one mode-0600 secret", () => {
    const target = configPath();
    const provision = provisionPrimaryBetterAuthSecret(target, undefined);
    const secret = readPaperclipEnvEntries(provision.path).BETTER_AUTH_SECRET;

    expect(provision.source).toBe("generated");
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fs.statSync(provision.path).mode & 0o777).toBe(0o600);
  });

  it("persists an explicitly provisioned secret without exposing it in the result", () => {
    const target = configPath();
    const provision = provisionPrimaryBetterAuthSecret(
      target,
      "explicit-primary-better-auth-secret",
    );

    expect(provision).toEqual({
      path: path.join(path.dirname(target), ".env"),
      source: "environment",
    });
    expect(readPaperclipEnvEntries(provision.path).BETTER_AUTH_SECRET).toBe(
      "explicit-primary-better-auth-secret",
    );
    expect(provision).not.toHaveProperty("secret");
  });

  it("reuses the creation-owned value and rejects a conflicting rotation", () => {
    const target = configPath();
    const first = provisionPrimaryBetterAuthSecret(target, undefined);
    const firstSecret = readPaperclipEnvEntries(first.path).BETTER_AUTH_SECRET;

    expect(provisionPrimaryBetterAuthSecret(target, undefined).source).toBe(
      "existing",
    );
    expect(() =>
      provisionPrimaryBetterAuthSecret(target, "different-secret"),
    ).toThrow(/Refusing to rotate deployment identity/);
    expect(readPaperclipEnvEntries(first.path).BETTER_AUTH_SECRET).toBe(
      firstSecret,
    );
  });
});
