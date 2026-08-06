/**
 * Single source of truth for adapter display metadata.
 *
 * The server supplies every concrete agent label and configuration. This module
 * contains only neutral presentation for historical references that have no
 * current catalog snapshot; it deliberately has no per-agent map.
 */
export interface AdapterDisplayInfo {
  label: string;
  description: string;
}

function humanizeType(type: string): string {
  return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function getAdapterLabel(type: string): string {
  return humanizeType(type);
}

export function getAdapterDisplay(type: string): AdapterDisplayInfo {
  return {
    label: humanizeType(type),
    description: "Available from a local agent runtime",
  };
}
