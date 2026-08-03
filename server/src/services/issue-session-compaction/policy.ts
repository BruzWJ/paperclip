/**
 * Paperclip's complete no-context compaction policy surface.
 *
 * These policies are intentionally fixed. They are kept in one tiny module so
 * automated checks can reject a newly introduced prompt/context mutation.
 */

export const experimentalSessionCompacting = () => ({
  context: [] as const,
  prompt: undefined,
});

export const experimentalChatMessagesTransform = <T extends readonly unknown[]>(
  messages: T,
): T => messages;

export const experimentalCompactionAutocontinue = () => ({
  enabled: true as const,
});
