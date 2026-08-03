import { randomBytes } from "node:crypto";
import { chmodSync } from "node:fs";
import {
  mergePaperclipEnvEntries,
  readPaperclipEnvEntries,
  resolvePaperclipEnvFile,
} from "./env.js";

export type PrimaryBetterAuthSecretProvision = {
  path: string;
  source: "environment" | "existing" | "generated";
};

export function provisionPrimaryBetterAuthSecret(
  configPath: string,
  explicitSecret = process.env.BETTER_AUTH_SECRET,
): PrimaryBetterAuthSecretProvision {
  const envPath = resolvePaperclipEnvFile(configPath);
  const persistedSecret =
    readPaperclipEnvEntries(envPath).BETTER_AUTH_SECRET?.trim() || undefined;
  const providedSecret = explicitSecret?.trim() || undefined;

  if (
    persistedSecret &&
    providedSecret &&
    persistedSecret !== providedSecret
  ) {
    throw new Error(
      `BETTER_AUTH_SECRET conflicts with the value already owned by ${envPath}. Refusing to rotate deployment identity during onboarding.`,
    );
  }

  const secret =
    providedSecret ??
    persistedSecret ??
    randomBytes(32).toString("base64url");
  const source: PrimaryBetterAuthSecretProvision["source"] = providedSecret
    ? "environment"
    : persistedSecret
      ? "existing"
      : "generated";

  mergePaperclipEnvEntries({ BETTER_AUTH_SECRET: secret }, envPath);
  try {
    chmodSync(envPath, 0o600);
  } catch {
    // The environment owner already requests mode 0600; chmod is best-effort on
    // filesystems that do not expose POSIX permissions.
  }

  return { path: envPath, source };
}
