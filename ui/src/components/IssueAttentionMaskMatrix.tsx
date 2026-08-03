import {
  AGENT_CONTEXT_GRANT_KEYS,
  normalizeIssueAttentionMask,
  type AgentContextGrantKey,
  type IssueAttentionMask,
} from "@paperclipai/shared";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

const TIER_LABELS = ["Current issue", "Sub-issues", "Company issues"] as const;
const DEPTH_LABELS = ["Content", "Comments", "Agent runs"] as const;

const MATRIX_ROWS = TIER_LABELS.map((tier, tierIndex) => ({
  tier,
  cells: DEPTH_LABELS.map((depth, depthIndex) => ({
    depth,
    key: AGENT_CONTEXT_GRANT_KEYS[
      tierIndex * DEPTH_LABELS.length + depthIndex
    ]!,
  })),
}));

function toggleMaskCell(
  value: IssueAttentionMask | null,
  key: AgentContextGrantKey,
): IssueAttentionMask | null {
  const next: IssueAttentionMask = {
    ...(normalizeIssueAttentionMask(value) ?? {}),
  };
  if (next[key] === false) {
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
  return (
    <div
      className={cn("space-y-2", className)}
      data-testid="issue-attention-mask-matrix"
    >
      <div className="grid grid-cols-4 gap-1 text-xs">
        <div className="px-2 py-1 text-muted-foreground">Attention</div>
        {DEPTH_LABELS.map((depth) => (
          <div
            key={depth}
            className="px-2 py-1 text-center font-medium text-muted-foreground"
          >
            {depth}
          </div>
        ))}
        {MATRIX_ROWS.flatMap(({ tier, cells }) => [
          <div
            key={`${tier}:label`}
            className="flex items-center rounded-md bg-muted/40 px-2 py-2 font-medium"
          >
            {tier}
          </div>,
          ...cells.map(({ depth, key }) => {
            const narrowed = canonicalValue?.[key] === false;
            const label = `${tier} ${depth}: ${
              narrowed ? "narrowed" : "unchanged"
            }`;
            return (
              <label
                key={key}
                className={cn(
                  "flex min-h-9 items-center justify-center gap-2 rounded-md border border-border px-2 py-1.5",
                  narrowed && "bg-muted/60 text-muted-foreground",
                  !readOnly && "cursor-pointer hover:bg-accent/40",
                )}
                title={label}
              >
                <Checkbox
                  checked={!narrowed}
                  disabled={readOnly}
                  aria-label={label}
                  onCheckedChange={() => {
                    if (!readOnly) {
                      onChange?.(toggleMaskCell(canonicalValue, key));
                    }
                  }}
                />
                <span className="sr-only">{label}</span>
              </label>
            );
          }),
        ])}
      </div>
      <p className="text-xs text-muted-foreground">
        {readOnly
          ? "Checked cells use the owner's configured attention; unchecked cells were narrowed for this issue."
          : "Uncheck only what this issue should narrow. Checked cells leave the owner's configuration unchanged."}
      </p>
    </div>
  );
}
