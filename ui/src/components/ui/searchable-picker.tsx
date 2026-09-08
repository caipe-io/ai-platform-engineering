"use client";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { AlertCircle, Check, ChevronDown, Loader2, Search, X } from "lucide-react";
import * as React from "react";

export interface SearchablePickerRenderState {
  active: boolean;
  selected: boolean;
}

export interface SearchablePickerProps<Option> {
  options: readonly Option[];
  selected?: Option;
  onSelect: (option: Option) => void;
  getOptionKey: (option: Option) => string;
  getOptionLabel: (option: Option) => string;
  getSearchText?: (option: Option) => readonly string[];
  isOptionDisabled?: (option: Option) => boolean;
  renderValue?: (option: Option) => React.ReactNode;
  renderOption?: (
    option: Option,
    state: SearchablePickerRenderState,
  ) => React.ReactNode;
  placeholder: string;
  searchPlaceholder: string;
  emptyLabel: string;
  disabled?: boolean;
  required?: boolean;
  id?: string;
  ariaLabel?: string;
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;
  triggerClassName?: string;
  contentClassName?: string;
  clearLabel?: string;
  onClear?: () => void;
  helperText?: React.ReactNode;
  loading?: boolean;
  loadingLabel?: string;
  error?: string | null;
  onRetry?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  loadMoreLabel?: string;
  searchValue?: string;
  onSearchChange?: (query: string) => void;
  filterOptions?: boolean;
  portalled?: boolean;
  contentSide?: "top" | "bottom";
}

function defaultSearchText<Option>(
  option: Option,
  getOptionKey: (option: Option) => string,
  getOptionLabel: (option: Option) => string,
): readonly string[] {
  return [getOptionLabel(option), getOptionKey(option)];
}

export function SearchablePicker<Option>({
  options,
  selected,
  onSelect,
  getOptionKey,
  getOptionLabel,
  getSearchText,
  isOptionDisabled = () => false,
  renderValue,
  renderOption,
  placeholder,
  searchPlaceholder,
  emptyLabel,
  disabled = false,
  required = false,
  id,
  ariaLabel,
  ariaInvalid,
  ariaDescribedBy,
  triggerClassName,
  contentClassName,
  clearLabel = "Clear selection",
  onClear,
  helperText,
  loading = false,
  loadingLabel = "Loading options...",
  error,
  onRetry,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  loadMoreLabel = "Load more",
  searchValue,
  onSearchChange,
  filterOptions = true,
  portalled = true,
  contentSide = "bottom",
}: SearchablePickerProps<Option>) {
  const [open, setOpen] = React.useState(false);
  const [internalQuery, setInternalQuery] = React.useState("");
  const [activeKey, setActiveKey] = React.useState<string | null>(null);
  const listboxId = React.useId();
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const query = searchValue ?? internalQuery;
  const selectedKey = selected ? getOptionKey(selected) : null;

  const resetSearch = React.useCallback(() => {
    if (searchValue === undefined) setInternalQuery("");
    onSearchChange?.("");
    setActiveKey(null);
  }, [onSearchChange, searchValue]);

  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) resetSearch();
    },
    [resetSearch],
  );

  React.useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      searchRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const visibleOptions = React.useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const matches = !filterOptions || !needle
      ? [...options]
      : options.filter((option) => {
          const searchText = getSearchText
            ? getSearchText(option)
            : defaultSearchText(option, getOptionKey, getOptionLabel);
          return searchText.some((value) =>
            value.toLocaleLowerCase().includes(needle),
          );
        });

    if (!selectedKey) return matches;
    const matchedSelection = matches.find(
      (option) => getOptionKey(option) === selectedKey,
    );
    if (!matchedSelection) return matches;
    return [
      matchedSelection,
      ...matches.filter((option) => getOptionKey(option) !== selectedKey),
    ];
  }, [
    filterOptions,
    getOptionKey,
    getOptionLabel,
    getSearchText,
    options,
    query,
    selectedKey,
  ]);

  const enabledOptions = React.useMemo(
    () => visibleOptions.filter((option) => !isOptionDisabled(option)),
    [isOptionDisabled, visibleOptions],
  );
  const activeOption =
    enabledOptions.find((option) => getOptionKey(option) === activeKey) ??
    enabledOptions[0];
  const activeIndex = activeOption ? visibleOptions.indexOf(activeOption) : -1;
  const activeOptionId = activeIndex >= 0
    ? `${listboxId}-option-${activeIndex}`
    : undefined;

  const focusTrigger = React.useCallback(() => {
    triggerRef.current?.focus();
  }, []);

  const closeAndFocusTrigger = React.useCallback(() => {
    handleOpenChange(false);
    focusTrigger();
  }, [focusTrigger, handleOpenChange]);

  const choose = React.useCallback(
    (option: Option) => {
      if (isOptionDisabled(option)) return;
      onSelect(option);
      closeAndFocusTrigger();
    },
    [closeAndFocusTrigger, isOptionDisabled, onSelect],
  );

  const moveActive = React.useCallback(
    (direction: 1 | -1) => {
      if (enabledOptions.length === 0) return;
      const currentIndex = activeOption
        ? enabledOptions.indexOf(activeOption)
        : direction === 1
          ? -1
          : 0;
      const nextIndex =
        (currentIndex + direction + enabledOptions.length) % enabledOptions.length;
      const next = enabledOptions[nextIndex];
      setActiveKey(getOptionKey(next));
      const visibleIndex = visibleOptions.indexOf(next);
      window.requestAnimationFrame(() => {
        document
          .getElementById(`${listboxId}-option-${visibleIndex}`)
          ?.scrollIntoView?.({ block: "nearest" });
      });
    }, [activeOption, enabledOptions, getOptionKey, listboxId, visibleOptions]);

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Home" && enabledOptions.length > 0) {
      event.preventDefault();
      setActiveKey(getOptionKey(enabledOptions[0]));
      return;
    }
    if (event.key === "End" && enabledOptions.length > 0) {
      event.preventDefault();
      setActiveKey(getOptionKey(enabledOptions[enabledOptions.length - 1]));
      return;
    }
    if (event.key === "Enter" && activeOption) {
      event.preventDefault();
      choose(activeOption);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeAndFocusTrigger();
    }
  };

  const handleTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActiveKey(null);
    }
  };

  const updateQuery = (next: string) => {
    if (searchValue === undefined) setInternalQuery(next);
    onSearchChange?.(next);
    setActiveKey(null);
  };

  const canClear = Boolean(selected && onClear && !required && !disabled);
  const accessibleName = ariaLabel || placeholder;

  return (
    <Popover open={open} onOpenChange={handleOpenChange} className="w-full min-w-0">
      <div className="relative w-full min-w-0">
        <PopoverTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            id={id}
            role="combobox"
            aria-label={ariaLabel}
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-controls={listboxId}
            aria-required={required || undefined}
            aria-invalid={ariaInvalid || undefined}
            aria-describedby={ariaDescribedBy}
            disabled={disabled}
            onKeyDown={handleTriggerKeyDown}
            className={cn(
              "inline-flex w-full items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-left text-sm",
              "hover:bg-muted/40 focus:outline-none focus:ring-1 focus:ring-ring",
              "disabled:cursor-not-allowed disabled:opacity-60",
              "pr-8",
              canClear && "pr-14",
              triggerClassName,
            )}
          >
            <span className="flex min-w-0 flex-1 items-center gap-2">
              {selected ? (
                renderValue?.(selected) ?? (
                  <span className="truncate">{getOptionLabel(selected)}</span>
                )
              ) : (
                <span className="truncate text-muted-foreground">{placeholder}</span>
              )}
            </span>
          </button>
        </PopoverTrigger>
        <ChevronDown
          className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        {canClear && (
          <button
            type="button"
            aria-label={clearLabel}
            className="absolute right-7 top-1/2 z-10 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            onClick={(event) => {
              event.stopPropagation();
              onClear?.();
              focusTrigger();
            }}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
      <PopoverContent
        align="start"
        side={contentSide}
        className={cn("w-[min(360px,90vw)] p-0", contentClassName)}
        portalled={portalled}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => updateQuery(event.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder={searchPlaceholder}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            autoFocus
            role="searchbox"
            aria-label={searchPlaceholder}
            aria-controls={listboxId}
            aria-activedescendant={activeOptionId}
            aria-autocomplete="list"
          />
        </div>
        {helperText && (
          <div className="px-3 pb-0 pt-1.5 text-[11px] text-muted-foreground">
            {helperText}
          </div>
        )}
        <div
          id={listboxId}
          className="max-h-[260px] overflow-y-auto py-1"
          role="listbox"
          aria-label={accessibleName}
          aria-busy={loading || loadingMore || undefined}
        >
          {loading && visibleOptions.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground" role="status">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              {loadingLabel}
            </div>
          ) : error ? (
            <div className="space-y-2 px-3 py-3 text-xs text-destructive" role="alert">
              <span className="flex items-center gap-2">
                <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
                {error}
              </span>
              {onRetry && (
                <button
                  type="button"
                  className="font-medium underline underline-offset-2"
                  onClick={onRetry}
                >
                  Retry
                </button>
              )}
            </div>
          ) : visibleOptions.length === 0 ? (
            <div className="px-3 py-3 text-xs text-muted-foreground" role="status">
              {emptyLabel}
            </div>
          ) : (
            visibleOptions.map((option, index) => {
              const optionKey = getOptionKey(option);
              const isSelected = optionKey === selectedKey;
              const isActive = option === activeOption;
              const optionDisabled = isOptionDisabled(option);
              return (
                <button
                  key={optionKey}
                  id={`${listboxId}-option-${index}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={isSelected}
                  disabled={optionDisabled}
                  onMouseEnter={() => {
                    if (!optionDisabled) setActiveKey(optionKey);
                  }}
                  onClick={() => choose(option)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm",
                    "hover:bg-muted/50 focus:bg-muted/50 focus:outline-none",
                    (isSelected || isActive) && "bg-muted/30",
                    optionDisabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
                  )}
                >
                  <Check
                    className={cn(
                      "h-3.5 w-3.5 shrink-0",
                      isSelected ? "text-primary" : "text-transparent",
                    )}
                    aria-hidden="true"
                  />
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    {renderOption?.(option, {
                      active: isActive,
                      selected: isSelected,
                    }) ?? <span className="truncate">{getOptionLabel(option)}</span>}
                  </span>
                </button>
              );
            })
          )}
        </div>
        {hasMore && !error && (
          <div className="border-t border-border p-1.5">
            <button
              type="button"
              className="flex w-full items-center justify-center gap-2 rounded-sm px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground disabled:opacity-50"
              disabled={loadingMore || !onLoadMore}
              onClick={onLoadMore}
            >
              {loadingMore && (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              )}
              {loadingMore ? loadingLabel : loadMoreLabel}
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
