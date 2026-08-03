/**
 * Single source of truth for adapter display metadata.
 *
 * Known adapters may add richer presentation metadata. Every other entry is
 * still server-admitted and receives neutral ACP presentation metadata.
 */
import type { ComponentType } from "react";
import { Cpu } from "lucide-react";

// ---------------------------------------------------------------------------
// Display metadata per adapter type
// ---------------------------------------------------------------------------

export interface AdapterDisplayInfo {
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  recommended?: boolean;
  comingSoon?: boolean;
  disabledLabel?: string;
  experimental?: boolean;
  hideFromVisualSelection?: boolean;
}

const adapterDisplayMap: Record<string, AdapterDisplayInfo> = {
  codex: {
    label: "Codex",
    description: "Codex through the pinned ACP frontend",
    icon: Cpu,
    recommended: true,
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function humanizeType(type: string): string {
  return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function getAdapterLabel(type: string): string {
  const known = adapterDisplayMap[type];
  if (known) return known.label;
  return humanizeType(type);
}

export function getAdapterLabels(): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const [type, info] of Object.entries(adapterDisplayMap)) {
    labels[type] = info.label;
  }
  return labels;
}

export function getAdapterDisplay(type: string): AdapterDisplayInfo {
  const known = adapterDisplayMap[type];
  if (known) return known;

  return {
    label: humanizeType(type),
    description: "Server-admitted ACP frontend",
    icon: Cpu,
  };
}

export function isKnownAdapterType(type: string): boolean {
  return type in adapterDisplayMap;
}
