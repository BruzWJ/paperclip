export function isPdfAttachment(mime: string) {
  return mime === "application/pdf";
}

export function isMedia(mime: string) {
  return mime.startsWith("image/") || isPdfAttachment(mime);
}
