export interface OrderedExecutionScopeMember {
  readonly executionScopeId: string;
  readonly executionLineageId: string;
  readonly laneOrdinal: number;
}

/**
 * Recognizes the sole two-member session-start shape persisted by atomic batch
 * admission. Source vocabulary and Session message kind do not participate:
 * the shared execution scope and adjacent lane ordinals are the proof.
 */
export function classifyOrderedExecutionScopePair<
  Member extends OrderedExecutionScopeMember,
>(
  refs: readonly Member[],
): { readonly instruction: Member; readonly work: Member } | null {
  if (refs.length !== 2) return null;
  const [instruction, work] = refs[0]!.laneOrdinal < refs[1]!.laneOrdinal
    ? [refs[0]!, refs[1]!]
    : [refs[1]!, refs[0]!];
  return Number.isSafeInteger(instruction.laneOrdinal) &&
      instruction.laneOrdinal >= 0 &&
      work.laneOrdinal === instruction.laneOrdinal + 1 &&
      instruction.executionScopeId === work.executionScopeId &&
      instruction.executionLineageId === work.executionLineageId
    ? { instruction, work }
    : null;
}
