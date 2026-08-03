import {
  AGENT_CONTEXT_GRANT_KEYS,
  normalizeIssueAttentionMask,
  type AgentContextGrantKey,
  type IssueAttentionMask,
} from "@paperclipai/shared";
import { AttentionMatrix } from "./AttentionMatrix";

function toggleMaskCell(
  value: IssueAttentionMask | null,
  key: AgentContextGrantKey,
  enabled: boolean,
): IssueAttentionMask | null {
  const next: IssueAttentionMask = {
    ...(normalizeIssueAttentionMask(value) ?? {}),
  };
  if (enabled) {
    delete next[key];
  } else {
    next[key] = false;
  }
  return Object.keys(next).length > 0 ? next : null;
}

export function IssueAttentionMaskMatrix({
  value,
  onChange,
  readOnly = false,
  className,
}: {
  value: IssueAttentionMask | null;
  onChange?: (value: IssueAttentionMask | null) => void;
  readOnly?: boolean;
  className?: string;
}) {
  const canonicalValue = normalizeIssueAttentionMask(value);
  const matrixValue = Object.fromEntries(
    AGENT_CONTEXT_GRANT_KEYS.map((key) => [
      key,
      canonicalValue?.[key] !== false,
    ]),
  ) as Record<AgentContextGrantKey, boolean>;

  return (
    <AttentionMatrix
      value={matrixValue}
      disabled={readOnly}
      enabledLabel="unchanged"
      disabledLabel="narrowed"
      description={
        readOnly
          ? "Checked cells use the owner's configured attention; unchecked cells were narrowed for this issue."
          : "Uncheck only what this issue should narrow. Checked cells leave the owner's configuration unchanged."
      }
      className={className}
      testId="issue-attention-mask-matrix"
      onCellChange={(key, enabled) =>
        onChange?.(toggleMaskCell(canonicalValue, key, enabled))
      }
    />
  );
}
