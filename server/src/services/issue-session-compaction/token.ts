const CHARS_PER_TOKEN = 4;

export const estimate = (input: string) => Math.max(0, Math.round(input.length / CHARS_PER_TOKEN));

export { CHARS_PER_TOKEN };
