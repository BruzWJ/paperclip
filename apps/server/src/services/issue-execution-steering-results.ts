export interface IssueExecutionSteeringResultIdentity {
  readonly companyId: string;
  readonly issueId: string;
  readonly runId: string;
  readonly refId: string;
  readonly refOrdinal: number;
  readonly segmentOrdinal: number;
}

export interface IssueExecutionSteeringResult
  extends IssueExecutionSteeringResultIdentity {
  readonly outcome: "succeeded" | "failed" | "cancelled";
  readonly response: string;
  readonly reason: string | null;
}

export interface IssueExecutionSteeringResultExpectation {
  readonly result: Promise<IssueExecutionSteeringResult>;
  cancel(): void;
}

export interface IssueExecutionSteeringResultBroker {
  expect(
    identity: IssueExecutionSteeringResultIdentity,
  ): IssueExecutionSteeringResultExpectation;
  rebind(
    interrupted: IssueExecutionSteeringResultIdentity,
    continuation: IssueExecutionSteeringResultIdentity,
  ): void;
  publish(result: IssueExecutionSteeringResult): void;
}

function exactIdentity(
  identity: IssueExecutionSteeringResultIdentity,
): void {
  for (const value of [
    identity.companyId,
    identity.issueId,
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

function identityKey(identity: IssueExecutionSteeringResultIdentity): string {
  exactIdentity(identity);
  return [
    identity.companyId,
    identity.issueId,
    identity.runId,
    identity.refId,
    identity.refOrdinal,
    identity.segmentOrdinal,
  ].join("\0");
}

/**
 * Worker-local rendezvous for the synchronous selector-bearing mention call.
 * Canonical output remains in the issue Session; this broker owns no replay,
 * persistence, transcript, or provider state.
 */
export function createIssueExecutionSteeringResultBroker(): IssueExecutionSteeringResultBroker {
  const expectations = new Map<
    string,
    Set<(result: IssueExecutionSteeringResult) => void>
  >();
  return Object.freeze({
    expect(identity: IssueExecutionSteeringResultIdentity) {
      const key = identityKey(identity);
      let resolveResult!: (result: IssueExecutionSteeringResult) => void;
      const result = new Promise<IssueExecutionSteeringResult>((resolve) => {
        resolveResult = resolve;
      });
      const resolvers =
        expectations.get(key) ??
        new Set<(result: IssueExecutionSteeringResult) => void>();
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
      interrupted: IssueExecutionSteeringResultIdentity,
      continuation: IssueExecutionSteeringResultIdentity,
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
        new Set<(result: IssueExecutionSteeringResult) => void>();
      for (const resolve of interruptedResolvers) {
        continuationResolvers.add(resolve);
      }
      expectations.set(continuationKey, continuationResolvers);
    },
    publish(result: IssueExecutionSteeringResult) {
      const key = identityKey(result);
      const resolvers = expectations.get(key);
      if (!resolvers) return;
      expectations.delete(key);
      const frozen = Object.freeze({ ...result });
      for (const resolve of resolvers) resolve(frozen);
    },
  });
}
