export function orderedIdsEqual(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function completeOrderedIds<T extends { id: string }>(
  items: readonly T[],
  requestedIds: readonly string[],
  fallbackOrder: readonly T[] = items,
) {
  const availableIds = new Set(items.map((item) => item.id));
  const result = requestedIds.filter((id) => availableIds.has(id));
  for (const item of fallbackOrder) {
    if (!result.includes(item.id)) result.push(item.id);
  }
  return result;
}
