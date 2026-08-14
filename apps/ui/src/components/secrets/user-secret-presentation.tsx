import type { UserSecretCoverageSummary } from "@paperclipai/shared";
export type MyValueState = "set" | "not_set" | "inactive";

export function myValueLabel(state: MyValueState): string {
  switch (state) {
    case "set":
      return "Value set";
    case "not_set":
      return "Not set";
    case "inactive":
      return "Disabled";
  }
}

/**
 * Coverage is surfaced as counts only, never values, per the UX terminology
 * decisions. E.g. "5 of 7 members set".
 */
export function coverageSummaryLabel(summary: UserSecretCoverageSummary | undefined): string {
  if (!summary) return "—";
  const total = summary.configuredCount + summary.missingCount + summary.inactiveCount;
  return `${summary.configuredCount} of ${total} set`;
}
