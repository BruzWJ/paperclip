import { assertOnlySearchKeys, optionalSearchEnum } from "@/routes/-search";

export function validateApprovalDetailSearch(search: Record<string, unknown>): {
  resolved?: "approved";
} {
  assertOnlySearchKeys(search, ["resolved"]);
  return {
    resolved: optionalSearchEnum(search.resolved, ["approved"] as const, "resolved"),
  };
}
