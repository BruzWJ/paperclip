import { unprocessable } from "../errors.js";

export function sanitizePathSegment(input: string) {
  return input
    .trim()
    .replace(/[^A-Za-z0-9/_+=.@-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

export function requireExactAwsIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw unprocessable(`${label} must be a non-empty exact value without surrounding whitespace`);
  }
  return value;
}

export function requireOptionalExactAwsIdentity(value: unknown, label: string): string | null {
  return value == null ? null : requireExactAwsIdentity(value, label);
}
