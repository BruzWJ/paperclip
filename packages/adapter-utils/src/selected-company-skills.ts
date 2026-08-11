import { createHash } from "node:crypto";

const RUNTIME_NAME_RE = /^[A-Za-z0-9._-]+$/;

export class InvalidSelectedCompanySkillSet extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSelectedCompanySkillSet";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactIdentity(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw new InvalidSelectedCompanySkillSet(
      `${label} must be exact and non-empty.`,
    );
  }
  return value;
}

function exactRuntimeName(value: string, key: string): string {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value !== value.trim() ||
    !RUNTIME_NAME_RE.test(value) ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new InvalidSelectedCompanySkillSet(
      `Selected company skill '${key}' has an unsafe runtime name.`,
    );
  }
  return value;
}

/** Derives the immutable provider-visible name for an ordinary company skill. */
export function selectedCompanySkillRuntimeName(
  keyValue: string,
  slugValue: string,
): string {
  const key = exactIdentity(keyValue, "company skill key");
  // The slug is mutable display metadata. Validate it, but derive the runtime
  // name only from the immutable skill key.
  exactRuntimeName(
    exactIdentity(slugValue, `company skill '${key}' slug`),
    key,
  );
  const pinnedName = exactRuntimeName(key.split("/").at(-1) ?? "", key);
  return exactRuntimeName(
    key.startsWith("paperclipai/paperclip/")
      ? pinnedName
      : `${pinnedName}--${sha256(key).slice(0, 10)}`,
    key,
  );
}
