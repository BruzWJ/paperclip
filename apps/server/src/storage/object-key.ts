import { badRequest } from "../errors.js";
import { isExactStorageObjectKey } from "@paperclipai/shared";

export { isExactStorageObjectKey };

export function requireExactStorageObjectKey(value: string): string {
  if (!isExactStorageObjectKey(value)) {
    throw badRequest(
      "Object key must be an exact slash-separated path using letters, numbers, dot, underscore, and hyphen",
    );
  }
  return value;
}
