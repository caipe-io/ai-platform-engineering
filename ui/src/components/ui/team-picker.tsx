"use client";

import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SearchablePicker } from "@/components/ui/searchable-picker";
import { cn } from "@/lib/utils";
import { Check, ChevronDown, Search, X } from "lucide-react";
import * as React from "react";

export interface TeamPickerOption {
  slug: string;
  name?: string;
  id?: string;
  _id?: string;
  description?: string;
  disabled?: boolean;
}

function labelOf(option: TeamPickerOption): string {
  return option.name?.trim() || option.slug;
}

function tokensFor(option: TeamPickerOption): string[] {
  return [option.slug, option.name ?? ""].filter(Boolean);
}

function matchesValue(option: TeamPickerOption, value: string): boolean {
  return Boolean(
    value &&
      (option.slug === value || option.id === value || option._id === value),
  );
}

interface CommonPickerProps {
  options: TeamPickerOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyLabel?: string;
  disabled?: boolean;
  triggerClassName?: string;
  contentClassName?: string;
  id?: string;
  ariaLabel?: string;
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;
  hideSlugSuffix?: boolean;
  portalled?: boolean;
  contentSide?: "top" | "bottom";
}

interface TeamPickerProps extends CommonPickerProps {
  value: string;
  onChange: (value: string) => void;
  toggleOnReselect?: boolean;
  helperText?: string;
  required?: boolean;
  allowClear?: boolean;
  loading?: boolean;
  loadingLabel?: string;
  error?: string | null;
  onRetry?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  searchValue?: string;
  onSearchChange?: (query: string) => void;
  filterOptions?: boolean;
}

export function TeamPicker({
  options,
  value,
  onChange,
  placeholder = "Select team...",
  searchPlaceholder = "Search teams...",
  emptyLabel = "No teams match",
  disabled = false,
  triggerClassName,
  contentClassName,
  id,
  ariaLabel,
  ariaInvalid,
  ariaDescribedBy,
  hideSlugSuffix = false,
  portalled = true,
  contentSide = "bottom",
  toggleOnReselect = false,
  helperText,
  required = false,
  allowClear = true,
  loading,
  loadingLabel,
  error,
  onRetry,
  hasMore,
  loadingMore,
  onLoadMore,
  searchValue,
  onSearchChange,
  filterOptions,
}: TeamPickerProps) {
  const selected = options.find((option) => matchesValue(option, value));

  const renderOption = (option: TeamPickerOption) => (
    <>
      <span className="min-w-0 flex-1 truncate">{labelOf(option)}</span>
      {!hideSlugSuffix && (
        <code className="min-w-0 shrink-[9999] truncate text-[10px] text-muted-foreground">
          team:{option.slug}
        </code>
      )}
    </>
  );

  return (
    <SearchablePicker
      options={options}
      selected={selected}
      onSelect={(option) => {
        onChange(toggleOnReselect && option === selected ? "" : option.slug);
      }}
      getOptionKey={(option) => option.slug}
      getOptionLabel={labelOf}
      getSearchText={tokensFor}
      isOptionDisabled={(option) => Boolean(option.disabled)}
      renderValue={renderOption}
      renderOption={renderOption}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      emptyLabel={emptyLabel}
      disabled={disabled}
      required={required}
      id={id}
      ariaLabel={ariaLabel}
      ariaInvalid={ariaInvalid}
      ariaDescribedBy={ariaDescribedBy}
      triggerClassName={triggerClassName}
      contentClassName={contentClassName}
      clearLabel="Clear team selection"
      onClear={allowClear ? () => onChange("") : undefined}
      helperText={helperText}
      loading={loading}
      loadingLabel={loadingLabel}
      error={error}
      onRetry={onRetry}
      hasMore={hasMore}
      loadingMore={loadingMore}
      onLoadMore={onLoadMore}
      searchValue={searchValue}
      onSearchChange={onSearchChange}
      filterOptions={filterOptions}
      portalled={portalled}
      contentSide={contentSide}
    />
  );
}

interface TeamMultiPickerProps extends CommonPickerProps {
  selected: string[];
  onChange: (next: string[]) => void;
  triggerChipCap?: number;
  helperText?: string;
  allowClearAll?: boolean;
  maxSelections?: number;
}

export function TeamMultiPicker({
  options,
  selected,
  onChange,
  placeholder = "Share with teams...",
  searchPlaceholder = "Search teams...",
  emptyLabel = "No teams match",
  disabled = false,
  triggerClassName,
  contentClassName,
  id,
  ariaLabel,
  ariaInvalid,
  ariaDescribedBy,
  hideSlugSuffix = false,
  portalled = true,
  contentSide = "bottom",
  triggerChipCap = 2,
  helperText,
  allowClearAll = true,
  maxSelections,
}: TeamMultiPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const listboxId = React.useId();
  const searchRef = React.useRef<HTMLInputElement>(null);

  const handleOpenChange = React.useCallback((next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  }, []);

  React.useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      searchRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const selectedOptions = React.useMemo(
    () =>
      selected.map(
        (value) =>
          options.find((option) => matchesValue(option, value)) ?? {
            slug: value,
          },
      ),
    [options, selected],
  );
  const selectedSet = React.useMemo(
    () => new Set(selectedOptions.map((option) => option.slug)),
    [selectedOptions],
  );

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const visible = needle
      ? options.filter((option) =>
          tokensFor(option).some((token) =>
            token.toLocaleLowerCase().includes(needle),
          ),
        )
      : options;
    return {
      selected: visible.filter((option) => selectedSet.has(option.slug)),
      available: visible.filter((option) => !selectedSet.has(option.slug)),
    };
  }, [options, query, selectedSet]);

  const remove = (option: TeamPickerOption) => {
    onChange(
      selected.filter(
        (value) =>
          value !== option.slug && value !== option.id && value !== option._id,
      ),
    );
  };

  const toggle = (option: TeamPickerOption) => {
    if (option.disabled) return;
    if (selectedSet.has(option.slug)) {
      remove(option);
      return;
    }
    if (maxSelections !== undefined && selected.length >= maxSelections) return;
    onChange([...selected, option.slug]);
  };

  const visibleChips = selectedOptions.slice(0, triggerChipCap);
  const overflow = selectedOptions.length - visibleChips.length;
  const atLimit =
    maxSelections !== undefined && selected.length >= maxSelections;
  const accessibleName = ariaLabel || placeholder;

  return (
    <Popover
      open={open}
      onOpenChange={handleOpenChange}
      className="w-full min-w-0"
    >
      <PopoverTrigger asChild>
        <div
          id={id}
          role="combobox"
          tabIndex={disabled ? -1 : 0}
          aria-label={accessibleName}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={listboxId}
          aria-invalid={ariaInvalid || undefined}
          aria-describedby={ariaDescribedBy}
          aria-disabled={disabled || undefined}
          className={cn(
            "flex min-h-10 w-full min-w-0 items-center gap-1 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm",
            "cursor-pointer focus:outline-none focus:ring-1 focus:ring-ring",
            disabled && "cursor-not-allowed opacity-60",
            triggerClassName,
          )}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (
              !disabled &&
              (event.key === "ArrowDown" ||
                event.key === "ArrowUp" ||
                event.key === "Enter" ||
                event.key === " ")
            ) {
              event.preventDefault();
              setOpen(true);
            }
          }}
        >
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {selectedOptions.length === 0 ? (
              <span className="truncate text-muted-foreground">{placeholder}</span>
            ) : (
              <>
                {visibleChips.map((option) => (
                  <Badge
                    key={option.slug}
                    variant="secondary"
                    className="h-6 gap-1 px-1.5 text-[11px]"
                  >
                    <span className="max-w-[140px] truncate">{labelOf(option)}</span>
                    {!disabled && (
                      <button
                        type="button"
                        aria-label={`Remove ${labelOf(option)}`}
                        className="rounded-sm text-muted-foreground hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                        onClick={(event) => {
                          event.stopPropagation();
                          remove(option);
                        }}
                      >
                        <X className="h-3 w-3" aria-hidden="true" />
                      </button>
                    )}
                  </Badge>
                ))}
                {overflow > 0 && (
                  <Badge variant="outline" className="h-6 px-1.5 text-[11px]">
                    +{overflow} more
                  </Badge>
                )}
              </>
            )}
          </div>
          {selectedOptions.length > 0 && allowClearAll && !disabled && (
            <button
              type="button"
              aria-label="Clear all selected teams"
              className="rounded-sm text-muted-foreground hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              onClick={(event) => {
                event.stopPropagation();
                onChange([]);
              }}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
          <ChevronDown
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        </div>
      </PopoverTrigger>
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
            onChange={(event) => setQuery(event.target.value)}
            placeholder={searchPlaceholder}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            autoFocus
            role="searchbox"
            aria-label={searchPlaceholder}
            aria-controls={listboxId}
          />
        </div>
        {helperText && (
          <div className="px-3 pb-0 pt-1.5 text-[11px] text-muted-foreground">
            {helperText}
          </div>
        )}
        <div
          id={listboxId}
          className="max-h-[280px] overflow-y-auto py-1"
          role="listbox"
          aria-label={accessibleName}
          aria-multiselectable="true"
        >
          {filtered.selected.length === 0 && filtered.available.length === 0 ? (
            <div className="px-3 py-3 text-xs text-muted-foreground" role="status">
              {emptyLabel}
            </div>
          ) : (
            <>
              {filtered.selected.length > 0 && (
                <div className="px-3 pb-1 pt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  Selected
                </div>
              )}
              {filtered.selected.map((option) => (
                <TeamOptionRow
                  key={`selected-${option.slug}`}
                  option={option}
                  selected
                  onToggle={() => toggle(option)}
                  hideSlugSuffix={hideSlugSuffix}
                />
              ))}
              {filtered.selected.length > 0 && filtered.available.length > 0 && (
                <div className="my-1 border-t border-border" />
              )}
              {filtered.available.length > 0 && (
                <div className="px-3 pb-1 pt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  Available
                </div>
              )}
              {filtered.available.map((option) => (
                <TeamOptionRow
                  key={`available-${option.slug}`}
                  option={atLimit ? { ...option, disabled: true } : option}
                  selected={false}
                  onToggle={() => toggle(option)}
                  hideSlugSuffix={hideSlugSuffix}
                />
              ))}
            </>
          )}
        </div>
        {selectedOptions.length > 0 && allowClearAll && (
          <div className="border-t border-border px-3 py-1.5 text-right">
            <button
              type="button"
              onClick={() => onChange([])}
              className="text-[11px] text-muted-foreground hover:text-foreground"
            >
              Clear all
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function TeamOptionRow({
  option,
  selected,
  onToggle,
  hideSlugSuffix,
}: {
  option: TeamPickerOption;
  selected: boolean;
  onToggle: () => void;
  hideSlugSuffix: boolean;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      disabled={option.disabled}
      onClick={onToggle}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm",
        "hover:bg-muted/50 focus:bg-muted/50 focus:outline-none",
        selected && "bg-muted/30",
        option.disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
      )}
    >
      <span
        className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-input",
          selected && "border-primary bg-primary",
        )}
      >
        {selected && (
          <Check className="h-3 w-3 text-primary-foreground" aria-hidden="true" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate">{labelOf(option)}</span>
      {!hideSlugSuffix && (
        <code className="min-w-0 shrink-[9999] truncate text-[10px] text-muted-foreground">
          team:{option.slug}
        </code>
      )}
    </button>
  );
}
