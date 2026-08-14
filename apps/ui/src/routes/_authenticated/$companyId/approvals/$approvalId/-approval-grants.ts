export function completeBooleanGrantMap<Key extends string>(
  keys: readonly Key[],
  values: Partial<Record<Key, boolean>>,
): Record<Key, boolean> {
  return Object.fromEntries(keys.map((key) => [key, values[key] === true])) as Record<Key, boolean>;
}
