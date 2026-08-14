import type { TaskExecutionPromptCycleRepository } from "./task-execution-attempt-executor.js";
import { createPostgresTaskExecutionPromptCycleRepositoryPart1 } from "./task-execution-prompt-cycle-postgres-part-1.js";
import { createPostgresTaskExecutionPromptCycleRepositoryPart2 } from "./task-execution-prompt-cycle-postgres-part-2.js";
import { createPostgresTaskExecutionPromptCycleRepositoryPart3 } from "./task-execution-prompt-cycle-postgres-part-3.js";
import { createPostgresTaskExecutionPromptCycleRepositoryPart4 } from "./task-execution-prompt-cycle-postgres-part-4.js";
import type {
  CreatePostgresTaskExecutionPromptCycleRepositoryResult,
  PostgresTaskExecutionPromptCycleOptions,
} from "./task-execution-prompt-cycle-postgres-shared.js";

export {
  nextCorrelationGeneration,
  PostgresTaskExecutionPromptCycleRejected,
  resolveInitialPromptCycleInTransaction,
  settleNonProtocolPromptInTransaction,
  type CreatePostgresTaskExecutionPromptCycleRepositoryResult,
  type PostgresTaskExecutionPromptCycleOptions,
} from "./task-execution-prompt-cycle-postgres-shared.js";
export function createPostgresTaskExecutionPromptCycleRepository(
  options: PostgresTaskExecutionPromptCycleOptions,
): TaskExecutionPromptCycleRepository {
  return {
    ...createPostgresTaskExecutionPromptCycleRepositoryPart1(options),
    ...createPostgresTaskExecutionPromptCycleRepositoryPart2(options),
    ...createPostgresTaskExecutionPromptCycleRepositoryPart3(options),
    ...createPostgresTaskExecutionPromptCycleRepositoryPart4(options),
  } as CreatePostgresTaskExecutionPromptCycleRepositoryResult;
}
