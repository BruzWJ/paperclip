export function parseExactInclude<const Selector extends string>(
  input: string,
  allowed: readonly Selector[],
): ReadonlySet<Selector> {
  const selectors = input.split(",");
  const selected = new Set<Selector>();

  for (const selector of selectors) {
    const exact = allowed.find((candidate) => candidate === selector);
    if (exact === undefined || selected.has(exact)) {
      throw new Error(
        `Invalid --include value. Use a non-empty, duplicate-free comma-separated subset of: ${allowed.join(",")}`,
      );
    }
    selected.add(exact);
  }

  return selected;
}
