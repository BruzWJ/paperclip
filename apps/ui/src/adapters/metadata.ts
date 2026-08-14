/**
 * Adapter metadata utilities — built on top of the display registry and UI adapter list.
 *
 * Admission, labels, and selectable membership always come from the exact
 * dynamic server catalog.
 */
import type { UIAdapterModule } from "./types";
import type { LabeledValue } from "@/lib/presentation-contracts";
import { findUIAdapter, listUIAdapters } from "./registry";

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
 * Every server-admitted local adapter appears in card-style visual pickers.
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
): LabeledValue[] {
  return adapters.map((adapter) => ({
    value: adapter.type,
    label: labelFor ? labelFor(adapter.type) : adapter.label,
  }));
}
