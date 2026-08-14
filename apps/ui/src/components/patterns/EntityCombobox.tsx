import { Check, ChevronsUpDown } from "lucide-react";
import {
  forwardRef,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEventHandler,
  type ReactNode,
  type Ref,
} from "react";

import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/kibo-ui/combobox";
import {
  ENTITY_NONE_VALUE,
  entityOptionMatchesSearch,
  type EntityOption,
  useEntitySelectorState,
} from "@/lib/entity-selector";
import { cn } from "@/lib/utils";

type TriggerProps = Omit<
  ComponentProps<typeof ComboboxTrigger>,
  "aria-label" | "children" | "className" | "disabled" | "ref" | "role" | "type"
>;

export interface EntityComboboxProps {
  value: string;
  options: EntityOption[];
  onValueChange: (value: string) => void;
  type: string;
  ariaLabel: string;
  placeholder: ReactNode;
  noneLabel: string;
  includeNone?: boolean;
  recentOptionIds?: string[];
  onConfirm?: () => void;
  disabled?: boolean;
  openOnFocus?: boolean;
  searchPlaceholder?: string;
  emptyMessage?: ReactNode;
  contentLeading?: ReactNode;
  triggerClassName?: string;
  triggerProps?: TriggerProps;
  contentClassName?: string;
  listClassName?: string;
  onContentKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  getOptionClassName?: (option: EntityOption) => string | undefined;
  /** Whether to render the chevrons beside the current trigger value. */
  showTriggerIndicator?: boolean;
  showSelectionIndicator?: boolean;
  renderValue?: (option: EntityOption | null) => ReactNode;
  renderOption?: (option: EntityOption) => ReactNode;
  optionGroups?:
    readonly EntityComboboxOptionGroup[] | ((searchQuery: string) => readonly EntityComboboxOptionGroup[]);
  shouldFilter?: boolean;
  onOptionSelect?: (option: EntityOption, searchQuery: string) => EntityComboboxSelectBehavior | void;
}

export interface EntityComboboxOptionGroup {
  id: string;
  label?: string;
  options: EntityOption[];
}

export type EntityComboboxSelectBehavior = "select" | "keep-open" | "close" | "close-without-focus";

function encodeOptionValue(option: EntityOption) {
  return option.commandValue ?? (option.id || ENTITY_NONE_VALUE);
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") {
    ref(value);
  } else if (ref) {
    ref.current = value;
  }
}

/**
 * Paperclip's domain adapter for the vendored Kibo combobox.
 *
 * It owns entity-specific ordering, empty-value encoding, focus handoff, and
 * rich trigger/item rendering so feature components only provide domain data.
 */
export const EntityCombobox = forwardRef<HTMLButtonElement, EntityComboboxProps>(function EntityCombobox(
  {
    value,
    options,
    onValueChange,
    type,
    ariaLabel,
    placeholder,
    noneLabel,
    includeNone = true,
    recentOptionIds = [],
    onConfirm,
    disabled = false,
    openOnFocus = true,
    searchPlaceholder,
    emptyMessage,
    contentLeading,
    triggerClassName,
    triggerProps,
    contentClassName,
    listClassName,
    onContentKeyDown,
    getOptionClassName,
    showTriggerIndicator = true,
    showSelectionIndicator = true,
    renderValue,
    renderOption,
    optionGroups,
    shouldFilter = true,
    onOptionSelect,
  },
  forwardedRef,
) {
  const triggerHostRef = useRef<HTMLSpanElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const suppressFocusOpenRef = useRef(false);
  const skipTriggerRestoreRef = useRef(false);
  const [searchQuery, setSearchQuery] = useState("");
  const selector = useEntitySelectorState({
    value,
    options,
    noneLabel,
    includeNone,
    recentOptionIds,
    onChange: onValueChange,
    onConfirm,
  });
  const encodedOptions = useMemo(
    () =>
      selector.orderedOptions.map((option) => ({
        option,
        value: encodeOptionValue(option),
      })),
    [selector.orderedOptions],
  );
  const resolvedGroups = useMemo(
    () => (typeof optionGroups === "function" ? optionGroups(searchQuery) : optionGroups),
    [optionGroups, searchQuery],
  );
  const displayedOptions = resolvedGroups
    ? resolvedGroups.flatMap((group) =>
        group.options.map((option) => ({ option, value: encodeOptionValue(option) })),
      )
    : encodedOptions;
  const optionByEncodedValue = new Map(displayedOptions.map((entry) => [entry.value, entry.option]));
  function resetSearch() {
    setSearchQuery("");
  }

  function close({ skipTriggerFocusRestore = false } = {}) {
    suppressFocusOpenRef.current = true;
    skipTriggerRestoreRef.current = skipTriggerFocusRestore;
    selector.pointerFocusRef.current = false;
    selector.setOpen(false);
    resetSearch();
  }

  function selectOption(option: EntityOption) {
    if (option.disabled) return;
    const behavior = onOptionSelect?.(option, searchQuery) ?? "select";
    if (behavior === "keep-open") {
      resetSearch();
      window.setTimeout(() => searchRef.current?.focus(), 0);
      return;
    }
    if (behavior === "close" || behavior === "close-without-focus") {
      close({ skipTriggerFocusRestore: behavior === "close-without-focus" });
      return;
    }
    suppressFocusOpenRef.current = true;
    skipTriggerRestoreRef.current = Boolean(onConfirm);
    selector.pointerFocusRef.current = false;
    resetSearch();
    selector.select(option);
  }

  useLayoutEffect(() => {
    const trigger = triggerHostRef.current?.querySelector<HTMLButtonElement>("button") ?? null;
    assignRef(forwardedRef, trigger);
    return () => assignRef(forwardedRef, null);
  }, [forwardedRef]);

  const {
    onFocus: onTriggerFocus,
    onPointerDown: onTriggerPointerDown,
    ...restTriggerProps
  } = triggerProps ?? {};
  const triggerIsIconOnly =
    triggerProps?.size === "icon" ||
    triggerProps?.size === "icon-xs" ||
    triggerProps?.size === "icon-sm" ||
    triggerProps?.size === "icon-lg";

  function renderItem(option: EntityOption, encodedValue: string) {
    return (
      <ComboboxItem
        key={encodedValue}
        value={encodedValue}
        keywords={[option.label, option.searchText ?? ""]}
        disabled={option.disabled}
        className={getOptionClassName?.(option)}
        onSelect={() => selectOption(option)}
      >
        {renderOption ? renderOption(option) : <span className="truncate">{option.label}</span>}
        {showSelectionIndicator ? (
          <Check
            aria-hidden="true"
            className={cn("ml-auto size-4", option.id === value ? "opacity-100" : "opacity-0")}
          />
        ) : null}
      </ComboboxItem>
    );
  }

  return (
    <Combobox
      data={displayedOptions.map((entry) => ({
        label: entry.option.label,
        value: entry.value,
      }))}
      type={type}
      value={value || ENTITY_NONE_VALUE}
      open={selector.open}
      onOpenChange={(open) => {
        selector.setOpen(open);
        if (!open) {
          selector.pointerFocusRef.current = false;
          resetSearch();
        }
      }}
    >
      <span ref={triggerHostRef} className="contents">
        <ComboboxTrigger
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={selector.open}
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn(
            triggerIsIconOnly ? "justify-center overflow-visible" : "w-full justify-between overflow-hidden",
            triggerClassName,
          )}
          onPointerDown={(event) => {
            onTriggerPointerDown?.(event);
            if (!event.defaultPrevented) selector.pointerFocusRef.current = true;
          }}
          onFocus={(event) => {
            onTriggerFocus?.(event);
            if (event.defaultPrevented || !openOnFocus || disabled) return;
            if (suppressFocusOpenRef.current) {
              suppressFocusOpenRef.current = false;
              return;
            }
            if (selector.pointerFocusRef.current) {
              selector.pointerFocusRef.current = false;
            } else {
              selector.setOpen(true);
            }
          }}
          {...restTriggerProps}
        >
          <span
            className={cn(
              "flex min-w-0 items-center gap-2 truncate text-left",
              !triggerIsIconOnly && "flex-1",
              !selector.currentOption && "text-muted-foreground",
            )}
          >
            {renderValue
              ? renderValue(selector.currentOption)
              : (selector.currentOption?.label ?? placeholder)}
          </span>
          {showTriggerIndicator ? <ChevronsUpDown className="size-4 shrink-0 opacity-50" /> : null}
        </ComboboxTrigger>
      </span>
      <ComboboxContent
        className={contentClassName}
        shouldFilter={shouldFilter}
        filter={(encodedValue, search) =>
          entityOptionMatchesSearch(optionByEncodedValue.get(encodedValue), search)
        }
        popoverOptions={{
          align: "start",
          collisionPadding: 16,
          onKeyDown: onContentKeyDown,
          onEscapeKeyDown: () => {
            suppressFocusOpenRef.current = true;
            skipTriggerRestoreRef.current = false;
          },
          onCloseAutoFocus: (event) => {
            if (!suppressFocusOpenRef.current) return;
            event.preventDefault();
            if (!skipTriggerRestoreRef.current) {
              triggerHostRef.current
                ?.querySelector<HTMLButtonElement>("button")
                ?.focus({ preventScroll: true });
            }
            suppressFocusOpenRef.current = false;
            skipTriggerRestoreRef.current = false;
          },
        }}
      >
        <ComboboxInput
          ref={searchRef}
          autoFocus
          value={searchQuery}
          onValueChange={setSearchQuery}
          placeholder={searchPlaceholder ?? `Search ${type}...`}
        />
        {contentLeading}
        <ComboboxList className={listClassName}>
          <ComboboxEmpty>{emptyMessage ?? `No ${type} found.`}</ComboboxEmpty>
          {resolvedGroups
            ? resolvedGroups.map((group) => (
                <ComboboxGroup key={group.id} heading={group.label}>
                  {group.options.map((option) => renderItem(option, encodeOptionValue(option)))}
                </ComboboxGroup>
              ))
            : encodedOptions.map(({ option, value: encodedValue }) => renderItem(option, encodedValue))}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
});
