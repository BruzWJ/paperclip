import { READABLE_TEXT_DARK, READABLE_TEXT_LIGHT } from "./color-contrast";

export type WorktreeUiBranding = {
  enabled: true;
  name: string;
  color: string;
  textColor: string;
};

function readMetaContent(name: string): string | null {
  if (typeof document === "undefined") return null;
  const content = document
    .querySelector(`meta[name="${name}"]`)
    ?.getAttribute("content")
    ?.trim();
  return content || null;
}

function normalizeHexColor(value: string | null): string | null {
  if (!value) return null;
  const hex = value.startsWith("#") ? value.slice(1) : value;
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return `#${hex.split("").map((char) => `${char}${char}`).join("").toLowerCase()}`;
  }
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex.toLowerCase()}` : null;
}

function relativeLuminanceChannel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.03928
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function pickReadableTextColor(background: string): string {
  const normalized = normalizeHexColor(background) ?? "#000000";
  const r = Number.parseInt(normalized.slice(1, 3), 16);
  const g = Number.parseInt(normalized.slice(3, 5), 16);
  const b = Number.parseInt(normalized.slice(5, 7), 16);
  const luminance =
    0.2126 * relativeLuminanceChannel(r) +
    0.7152 * relativeLuminanceChannel(g) +
    0.0722 * relativeLuminanceChannel(b);
  const lightContrast = 1.05 / (luminance + 0.05);
  const darkContrast = (luminance + 0.05) / 0.05;
  return lightContrast >= darkContrast ? READABLE_TEXT_LIGHT : READABLE_TEXT_DARK;
}

export function isWorktreeRuntime(): boolean {
  return readMetaContent("paperclip-worktree-enabled") === "true";
}

export function getWorktreeInstanceId(): string | null {
  return readMetaContent("paperclip-instance-id");
}

export function getWorktreeUiBranding(): WorktreeUiBranding | null {
  if (!isWorktreeRuntime()) return null;

  const name = readMetaContent("paperclip-worktree-name");
  const color = normalizeHexColor(readMetaContent("paperclip-worktree-color"));
  if (!name || !color) return null;

  return {
    enabled: true,
    name,
    color,
    textColor:
      normalizeHexColor(readMetaContent("paperclip-worktree-text-color")) ??
      pickReadableTextColor(color),
  };
}
