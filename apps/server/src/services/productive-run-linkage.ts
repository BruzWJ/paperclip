/**
 * Productive linkage remains a stable service import, while every query that
 * touches the canonical run root is owned by task-execution-run-service.
 */
export {
  resolveCurrentTaskOwnerRunLinkage,
  resolveCurrentTaskOwnerRunLinkages,
  resolveProductiveRunLinkage,
  type CurrentTaskOwnerRunLinkage,
  type ProductiveRunLinkage,
} from "./task-execution-run-service.js";
