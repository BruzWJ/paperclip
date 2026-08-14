import { type Db, routines, routineRuns, routineTriggers } from "@paperclipai/db";
import { trackRoutineRun } from "@paperclipai/shared/telemetry";
import { logger } from "../middleware/logger.js";
import { getTelemetryClient } from "../telemetry.js";
import { logActivity } from "./activity-log.js";

interface RoutineRunSideEffectInput {
  routine: typeof routines.$inferSelect;
  trigger: typeof routineTriggers.$inferSelect | null;
  source: "schedule" | "manual" | "api" | "webhook";
}

export async function recordRoutineRunSideEffects(
  db: Db,
  input: RoutineRunSideEffectInput,
  run: typeof routineRuns.$inferSelect,
): Promise<void> {
  if (input.source === "schedule" || input.source === "webhook") {
    const actorId = input.source === "schedule" ? "routine-scheduler" : "routine-webhook";
    try {
      await logActivity(db, {
        companyId: input.routine.companyId,
        actorType: "system",
        actorId,
        action: "routine.run_triggered",
        entityType: "routine_run",
        entityId: run.id,
        details: {
          routineId: input.routine.id,
          triggerId: input.trigger?.id ?? null,
          source: run.source,
          status: run.status,
        },
      });
    } catch (error) {
      logger.warn(
        { error, routineId: input.routine.id, runId: run.id },
        "failed to log automated routine run",
      );
    }
  }

  const telemetryClient = getTelemetryClient();
  if (telemetryClient) {
    trackRoutineRun(telemetryClient, {
      source: run.source,
      status: run.status,
    });
  }
}
