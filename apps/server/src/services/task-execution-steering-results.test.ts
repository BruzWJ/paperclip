import { describe, expect, it } from "vitest";
import { createTaskExecutionSteeringResultBroker } from "./task-execution-steering-results.js";

const identity = {
  companyId: "company",
  taskId: "task",
  runId: "run",
  refId: "ref",
  refOrdinal: 0,
  segmentOrdinal: 1,
} as const;

describe("task execution steering result broker", () => {
  it("rendezvouses one exact synchronous waiter without retaining output", async () => {
    const broker = createTaskExecutionSteeringResultBroker();
    const expectation = broker.expect(identity);
    broker.publish({
      ...identity,
      outcome: "succeeded",
      response: "continued response",
      reason: null,
    });
    await expect(expectation.result).resolves.toEqual({
      ...identity,
      outcome: "succeeded",
      response: "continued response",
      reason: null,
    });

    expect(() => broker.expect(identity)).not.toThrow();
  });

  it("moves concurrent waiters to the next interruption segment", async () => {
    const broker = createTaskExecutionSteeringResultBroker();
    const first = broker.expect(identity);
    const second = broker.expect(identity);
    const continuation = { ...identity, segmentOrdinal: 2 };
    broker.rebind(identity, continuation);
    broker.publish({
      ...continuation,
      outcome: "succeeded",
      response: "latest response",
      reason: null,
    });
    await expect(first.result).resolves.toMatchObject({
      segmentOrdinal: 2,
      response: "latest response",
    });
    await expect(second.result).resolves.toMatchObject({
      segmentOrdinal: 2,
      response: "latest response",
    });
  });

  it("permits explicit expectation cancellation", () => {
    const broker = createTaskExecutionSteeringResultBroker();
    const expectation = broker.expect(identity);
    expectation.cancel();
    expect(() =>
      broker.publish({
        ...identity,
        outcome: "succeeded",
        response: "ignored",
        reason: null,
      }),
    ).not.toThrow();
  });
});
