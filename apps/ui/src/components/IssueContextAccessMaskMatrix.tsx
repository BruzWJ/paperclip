import {
  AGENT_CONTEXT_GRANT_KEYS,
  normalizeContextAccess,
  type AgentContextGrantKey,
  type ContextAccess,
} from "@paperclipai/shared";
import { ContextAccessMatrix } from "./ContextAccessMatrix";

function toggleMaskCell(
  value: ContextAccess | null,
  key: AgentContextGrantKey,
  enabled: boolean,
): ContextAccess | null {
  const next: ContextAccess = {
    ...(normalizeContextAccess(value) ?? {}),
  };
  if (enabled) {
    delete next[key];
  } else {
    next[key] = false;
  }
  return Object.keys(next).length > 0 ? next : null;
}

export function IssueContextAccessMaskMatrix({
  value,
  onChange,
  readOnly = false,
  className,
}: {
  value: ContextAccess | null;
  onChange?: (value: ContextAccess | null) => void;
  readOnly?: boolean;
  className?: string;
}) {
  const canonicalValue = normalizeContextAccess(value);
  const matrixValue = Object.fromEntries(
    AGENT_CONTEXT_GRANT_KEYS.map((key) => [
      key,
      canonicalValue?.[key] !== false,
    ]),
  ) as Record<AgentContextGrantKey, boolean>;

  return (
    <ContextAccessMatrix
      value={matrixValue}
      disabled={readOnly}
      enabledLabel="unchanged"
      disabledLabel="narrowed"
      description={
        readOnly
          ? "Checked cells use the owner's configured context access; unchecked cells were narrowed for this issue."
          : "Uncheck only what this issue should narrow. Checked cells leave the owner's configuration unchanged."
      }
      className={className}
      testId="issue-context-access-mask-matrix"
      onCellChange={(key, enabled) =>
        onChange?.(toggleMaskCell(canonicalValue, key, enabled))
      }
    />
  );
}
