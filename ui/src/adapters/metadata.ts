/**
 * Adapter metadata utilities — built on top of the display registry and UI adapter list.
 *
 * Admission, labels, and selectable membership always come from the exact
 * dynamic server catalog.
 */
import type { UIAdapterModule } from "./types";
import { findUIAdapter, listUIAdapters } from "./registry";

export interface AdapterOptionMetadata {
  value: string;
  label: string;
}

export function listKnownAdapterTypes(): string[] {
  return listUIAdapters().map((adapter) => adapter.type);
}

/**
 * Only exact entries in the server-admitted UI catalog are enabled.
 */
export function isEnabledAdapterType(type: string): boolean {
  return findUIAdapter(type) !== null;
}

/**
 * Check whether an adapter type is a valid choice for new agent creation.
 * Includes only exact server-admitted, non-withheld adapter names.
 */
export function isValidAdapterType(type: string): boolean {
  return isEnabledAdapterType(type);
}

/**
 * Every server-admitted ACPX adapter appears in card-style visual pickers.
 */
export function isVisualAdapterChoice(type: string): boolean {
  return isEnabledAdapterType(type);
}

/**
 * Build option metadata for a list of adapters (for dropdowns).
 * `labelFor` callback allows callers to override labels; defaults to display registry.
 */
export function listAdapterOptions(
  labelFor?: (type: string) => string,
  adapters: UIAdapterModule[] = listUIAdapters(),
): AdapterOptionMetadata[] {
  return adapters.map((adapter) => ({
    value: adapter.type,
    label: labelFor ? labelFor(adapter.type) : adapter.label,
  }));
}

/**
 * List exact server-admitted UI adapters.
 */
export function listVisibleUIAdapters(): UIAdapterModule[] {
  return listUIAdapters();
}

/**
 * List visible adapter types (for non-React contexts like module-level constants).
 */
export function listVisibleAdapterTypes(): string[] {
  return listVisibleUIAdapters().map((a) => a.type);
}
