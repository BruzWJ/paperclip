/**
 * Single source of truth for adapter display metadata.
 *
 * ACPX supplies every concrete agent label and configuration. This module
 * contains only neutral presentation for historical references that have no
 * current catalog snapshot; it deliberately has no per-agent map.
 */
import type { ComponentType } from "react";
import { Cpu } from "lucide-react";

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

function humanizeType(type: string): string {
  return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function getAdapterLabel(type: string): string {
  return humanizeType(type);
}

export function getAdapterLabels(): Record<string, string> {
  return {};
}

export function getAdapterDisplay(type: string): AdapterDisplayInfo {
  return {
    label: humanizeType(type),
    description: "Discovered from ACPX at runtime",
    icon: Cpu,
  };
}

export function isKnownAdapterType(_type: string): boolean {
  return false;
}
