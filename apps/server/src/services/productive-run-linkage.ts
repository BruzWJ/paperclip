/**
 * Productive linkage remains a stable service import, while every query that
 * touches the canonical run root is owned by issue-execution-run-service.
 */
export {
  resolveCurrentIssueOwnerRunLinkage,
  resolveCurrentIssueOwnerRunLinkages,
  resolveProductiveRunLinkage,
  type CurrentIssueOwnerRunLinkage,
  type ProductiveRunLinkage,
} from "./issue-execution-run-service.js";
