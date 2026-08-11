export interface TaskExecutionSteeringResultIdentity {
  readonly companyId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly refId: string;
  readonly refOrdinal: number;
  readonly segmentOrdinal: number;
}

export interface TaskExecutionSteeringResult
  extends TaskExecutionSteeringResultIdentity {
  readonly outcome: "succeeded" | "failed" | "cancelled";
  readonly response: string;
  readonly reason: string | null;
}

export interface TaskExecutionSteeringResultExpectation {
  readonly result: Promise<TaskExecutionSteeringResult>;
  cancel(): void;
}

export interface TaskExecutionSteeringResultBroker {
  expect(
    identity: TaskExecutionSteeringResultIdentity,
  ): TaskExecutionSteeringResultExpectation;
  rebind(
    interrupted: TaskExecutionSteeringResultIdentity,
    continuation: TaskExecutionSteeringResultIdentity,
  ): void;
  publish(result: TaskExecutionSteeringResult): void;
}

function exactIdentity(
  identity: TaskExecutionSteeringResultIdentity,
): void {
  for (const value of [
    identity.companyId,
    identity.taskId,
    identity.runId,
    identity.refId,
  ]) {
    if (value.length === 0 || value !== value.trim()) {
      throw new TypeError("Steering result identity must be exact");
    }
  }
  if (
    !Number.isSafeInteger(identity.refOrdinal) ||
    identity.refOrdinal < 0 ||
    !Number.isSafeInteger(identity.segmentOrdinal) ||
    identity.segmentOrdinal < 1
  ) {
    throw new TypeError("Steering result requires a positive prompt segment");
  }
}

function identityKey(identity: TaskExecutionSteeringResultIdentity): string {
  exactIdentity(identity);
  return [
    identity.companyId,
    identity.taskId,
    identity.runId,
    identity.refId,
    identity.refOrdinal,
    identity.segmentOrdinal,
  ].join("\0");
}

/**
 * Worker-local rendezvous for the synchronous selector-bearing mention call.
 * Canonical output remains in the task Session; this broker owns no replay,
 * persistence, transcript, or provider state.
 */
export function createTaskExecutionSteeringResultBroker(): TaskExecutionSteeringResultBroker {
  const expectations = new Map<
    string,
    Set<(result: TaskExecutionSteeringResult) => void>
  >();
  return Object.freeze({
    expect(identity: TaskExecutionSteeringResultIdentity) {
      const key = identityKey(identity);
      let resolveResult!: (result: TaskExecutionSteeringResult) => void;
      const result = new Promise<TaskExecutionSteeringResult>((resolve) => {
        resolveResult = resolve;
      });
      const resolvers =
        expectations.get(key) ??
        new Set<(result: TaskExecutionSteeringResult) => void>();
      resolvers.add(resolveResult);
      expectations.set(key, resolvers);
      return Object.freeze({
        result,
        cancel() {
          for (const [currentKey, current] of expectations) {
            if (!current.delete(resolveResult)) continue;
            if (current.size === 0) {
              expectations.delete(currentKey);
            }
            break;
          }
        },
      });
    },
    rebind(
      interrupted: TaskExecutionSteeringResultIdentity,
      continuation: TaskExecutionSteeringResultIdentity,
    ) {
      const interruptedKey = identityKey(interrupted);
      const continuationKey = identityKey(continuation);
      if (interruptedKey === continuationKey) {
        throw new Error("Steering result rebind must advance the segment");
      }
      const interruptedResolvers = expectations.get(interruptedKey);
      if (!interruptedResolvers) return;
      expectations.delete(interruptedKey);
      const continuationResolvers =
        expectations.get(continuationKey) ??
        new Set<(result: TaskExecutionSteeringResult) => void>();
      for (const resolve of interruptedResolvers) {
        continuationResolvers.add(resolve);
      }
      expectations.set(continuationKey, continuationResolvers);
    },
    publish(result: TaskExecutionSteeringResult) {
      const key = identityKey(result);
      const resolvers = expectations.get(key);
      if (!resolvers) return;
      expectations.delete(key);
      const frozen = Object.freeze({ ...result });
      for (const resolve of resolvers) resolve(frozen);
    },
  });
}
