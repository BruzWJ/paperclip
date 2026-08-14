import { useMemo, useRef, useState } from "react";

import { orderItemsBySelectedAndRecent } from "@/lib/recent-selections";

export interface EntityOption {
  id: string;
  label: string;
  searchText?: string;
}

export const ENTITY_NONE_VALUE = "__entity_none__";

export function useEntitySelectorState({
  value,
  options,
  noneLabel,
  includeNone = true,
  recentOptionIds = [],
  onChange,
  onConfirm,
}: {
  value: string;
  options: EntityOption[];
  noneLabel: string;
  includeNone?: boolean;
  recentOptionIds?: string[];
  onChange: (id: string) => void;
  onConfirm?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const pointerFocusRef = useRef(false);
  const orderedOptions = useMemo(
    () =>
      orderItemsBySelectedAndRecent(
        includeNone ? [{ id: "", label: noneLabel, searchText: noneLabel }, ...options] : options,
        value,
        recentOptionIds,
      ),
    [includeNone, noneLabel, options, recentOptionIds, value],
  );
  const currentOption = options.find((option) => option.id === value) ?? null;

  return {
    open,
    setOpen,
    pointerFocusRef,
    orderedOptions,
    currentOption,
    select(option: EntityOption) {
      onChange(option.id);
      setOpen(false);
      if (onConfirm) requestAnimationFrame(onConfirm);
    },
  };
}

export function entityOptionMatchesSearch(option: EntityOption | undefined, search: string) {
  return `${option?.label ?? ""} ${option?.searchText ?? ""}`.toLowerCase().includes(search.toLowerCase())
    ? 1
    : 0;
}
