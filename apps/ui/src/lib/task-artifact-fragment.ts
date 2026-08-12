import { isCanonicalUuid } from "@paperclipai/shared";

export type TaskArtifactFragment = {
  kind: "work-product" | "attachment";
  id: string;
};

/** Parse the sole decoded task-artifact fragment admitted by the UI. */
export function parseTaskArtifactFragment(
  fragment: string,
): TaskArtifactFragment | null {
  const match = /^(work-product|attachment)-(.+)$/u.exec(fragment);
  if (!match || !isCanonicalUuid(match[2])) return null;
  return { kind: match[1] as TaskArtifactFragment["kind"], id: match[2] };
}
