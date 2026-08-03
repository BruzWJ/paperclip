export const AbortedError = {
  isInstance(input: unknown): boolean {
    return (
      typeof input === "object" &&
      input !== null &&
      "name" in input &&
      (input as { name?: unknown }).name === "MessageAbortedError"
    );
  },
};
