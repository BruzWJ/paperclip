export async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    throw new Error("Clipboard unavailable");
  }
  await navigator.clipboard.writeText(text);
}
