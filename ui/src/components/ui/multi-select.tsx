"use client";

// assisted-by Codex Codex-sonnet-4-6

import { Badge } from "@/components/ui/badge";
import { Popover,PopoverContent,PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { ChevronDown,Plus,Search,X } from "lucide-react";
import * as React from "react";

interface MultiSelectProps {
  options: string[];
  selected: string[];
  onChange: (selected: string[]) => void;
  formatOption?: (option: string) => string;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyLabel?: string;
  badgeLabel?: string;
  className?: string;
  portalled?: boolean;
}

export function MultiSelect({
  options,
  selected,
  onChange,
  formatOption = (option) => option,
  placeholder = "Select...",
  searchPlaceholder = "Search...",
  emptyLabel = "No results found",
  badgeLabel = "selected",
  className,
  portalled = true,
}: MultiSelectProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  const normalizedSearch = search.trim().toLowerCase();
  const filtered = normalizedSearch
    ? options.filter((o) => formatOption(o).toLowerCase().includes(normalizedSearch))
    : options;

  const toggle = (option: string) => {
    onChange(
      selected.includes(option)
        ? selected.filter((s) => s !== option)
        : [...selected, option]
    );
  };

  const remove = (option: string, e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(selected.filter((s) => s !== option));
  };

  const clearAll = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange([]);
  };

  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (!v) setSearch(""); }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1 h-8 min-w-[140px] max-w-[300px] rounded-md border border-input bg-background px-2 text-xs hover:bg-muted/50 focus:outline-none focus:ring-1 focus:ring-ring",
            className,
          )}
        >
          <div className="flex-1 flex items-center gap-1 overflow-hidden">
            {selected.length === 0 ? (
              <span className="text-muted-foreground">{placeholder}</span>
            ) : selected.length <= 2 ? (
              selected.map((s) => (
                <Badge key={s} variant="secondary" className="text-[10px] px-1.5 py-0 h-5 gap-0.5 shrink-0">
                  {formatOption(s)}
                  <X className="h-2.5 w-2.5 cursor-pointer" onClick={(e) => remove(s, e)} />
                </Badge>
              ))
            ) : (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-5 shrink-0">
                {selected.length} {badgeLabel}
              </Badge>
            )}
          </div>
          {selected.length > 0 && (
            <X className="h-3 w-3 text-muted-foreground hover:text-foreground shrink-0" onClick={clearAll} />
          )}
          <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[240px] p-0" portalled={portalled}>
        <div
          className="flex items-center gap-2 px-3 py-2 border-b border-border"
          onClick={() => inputRef.current?.focus()}
        >
          <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onInput={(e) => setSearch(e.currentTarget.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder={searchPlaceholder}
            data-testid="multi-select-search"
            className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            autoFocus
          />
        </div>
        <div className="max-h-[200px] overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">{emptyLabel}</div>
          ) : (
            filtered.map((option) => {
              const isSelected = selected.includes(option);
              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => toggle(option)}
                  className={cn(
                    "flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left hover:bg-muted/50 transition-colors",
                    isSelected && "bg-muted/30",
                  )}
                >
                  <div className={cn(
                    "h-3.5 w-3.5 rounded-sm border border-input shrink-0 flex items-center justify-center",
                    isSelected && "bg-primary border-primary",
                  )}>
                    {isSelected && (
                      <svg className="h-2.5 w-2.5 text-primary-foreground" viewBox="0 0 12 12" fill="none">
                        <path d="M2.5 6L5 8.5L9.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </div>
                  {formatOption(option)}
                </button>
              );
            })
          )}
        </div>
        {selected.length > 0 && (
          <div className="border-t border-border px-3 py-1.5">
            <button
              type="button"
              onClick={() => onChange([])}
              className="text-[10px] text-muted-foreground hover:text-foreground"
            >
              Clear all
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// TagInput — free-text tag entry (type + Enter to add, each tag is an OR term)
// ---------------------------------------------------------------------------

interface TagInputProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  badgeLabel?: string;
  className?: string;
}

export function TagInput({
  tags,
  onChange,
  placeholder = "Type & press Enter...",
  badgeLabel = "filters",
  className,
}: TagInputProps) {
  const [open, setOpen] = React.useState(false);
  const [input, setInput] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  const addTag = () => {
    const trimmed = input.trim();
    if (trimmed && !tags.includes(trimmed)) {
      onChange([...tags, trimmed]);
    }
    setInput("");
  };

  const removeTag = (tag: string, e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(tags.filter((t) => t !== tag));
  };

  const clearAll = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange([]);
  };

  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (!v) setInput(""); }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1 h-8 min-w-[140px] max-w-[300px] rounded-md border border-input bg-background px-2 text-xs hover:bg-muted/50 focus:outline-none focus:ring-1 focus:ring-ring",
            className,
          )}
        >
          <div className="flex-1 flex items-center gap-1 overflow-hidden">
            {tags.length === 0 ? (
              <span className="text-muted-foreground">{placeholder}</span>
            ) : tags.length <= 2 ? (
              tags.map((t) => (
                <Badge key={t} variant="secondary" className="text-[10px] px-1.5 py-0 h-5 gap-0.5 shrink-0">
                  {t}
                  <X className="h-2.5 w-2.5 cursor-pointer" onClick={(e) => removeTag(t, e)} />
                </Badge>
              ))
            ) : (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-5 shrink-0">
                {tags.length} {badgeLabel}
              </Badge>
            )}
          </div>
          {tags.length > 0 && (
            <X className="h-3 w-3 text-muted-foreground hover:text-foreground shrink-0" onClick={clearAll} />
          )}
          <Search className="h-3 w-3 text-muted-foreground shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[240px] p-0">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
          <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); addTag(); }
              if (e.key === "Backspace" && !input && tags.length > 0) {
                onChange(tags.slice(0, -1));
              }
            }}
            placeholder={placeholder}
            className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            autoFocus
          />
          {input.trim() && (
            <button type="button" onClick={addTag} className="text-primary hover:text-primary/80">
              <Plus className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {tags.length > 0 && (
          <div className="px-3 py-2 flex flex-wrap gap-1">
            {tags.map((t) => (
              <Badge key={t} variant="secondary" className="text-[10px] px-1.5 py-0.5 h-5 gap-0.5">
                {t}
                <X className="h-2.5 w-2.5 cursor-pointer" onClick={(e) => removeTag(t, e)} />
              </Badge>
            ))}
          </div>
        )}
        {tags.length > 0 && (
          <div className="border-t border-border px-3 py-1.5">
            <button
              type="button"
              onClick={() => onChange([])}
              className="text-[10px] text-muted-foreground hover:text-foreground"
            >
              Clear all
            </button>
          </div>
        )}
        {tags.length === 0 && (
          <div className="px-3 py-3 text-xs text-muted-foreground text-center">
            Type a search term and press Enter
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
