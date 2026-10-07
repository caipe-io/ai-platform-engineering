"use client";

import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { TeamPickerOption } from "@/components/ui/team-picker";
import { cn } from "@/lib/utils";
import { Check, ChevronDown, Loader2, Search, User, Users, X } from "lucide-react";
import * as React from "react";

export type AccessSubjectKind = "user" | "team";

export interface AccessSubjectRef {
  kind: AccessSubjectKind;
  id: string;
}

export interface AccessSubjectOption extends AccessSubjectRef {
  name: string;
  email?: string | null;
}

interface UserSearchRow {
  subject?: string;
  email?: string;
  name?: string;
}

interface CommonProps {
  teams: TeamPickerOption[];
  knownUsers?: AccessSubjectOption[];
  /** Subjects whose access is inherited and therefore cannot be toggled here. */
  implicitSelections?: AccessSubjectRef[];
  implicitSelectionLabel?:
    | string
    | ((selection: AccessSubjectRef) => string | undefined);
  placeholder: string;
  searchPlaceholder?: string;
  emptyLabel?: string;
  disabled?: boolean;
  id?: string;
  ariaLabel?: string;
  maxSelections?: number;
  maxSelectionsByKind?: Partial<Record<AccessSubjectKind, number>>;
}

function refKey(ref: AccessSubjectRef): string {
  return `${ref.kind}:${ref.id}`;
}

function sameRef(left: AccessSubjectRef, right: AccessSubjectRef): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function displayName(option: AccessSubjectOption): string {
  return option.name.trim() || option.email?.trim() || (option.kind === "team" ? "Unknown team" : "Unknown user");
}

function teamAccessOptions(teams: TeamPickerOption[]): AccessSubjectOption[] {
  return teams
    .filter((team) => Boolean(team.slug))
    .map((team) => ({
      kind: "team" as const,
      id: team.slug,
      name: team.name?.trim() || team.slug,
    }));
}

function userRows(payload: unknown): UserSearchRow[] {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const rows = Array.isArray(record.data) ? record.data : [];
  return rows.filter(
    (row): row is UserSearchRow => Boolean(row) && typeof row === "object",
  );
}

function normalizeKnownUsers(users: AccessSubjectOption[]): AccessSubjectOption[] {
  return users.filter(
    (user) => user.kind === "user" && Boolean(user.id.trim()),
  );
}

function AccessSubjectPickerBase({
  teams,
  knownUsers = [],
  implicitSelections = [],
  implicitSelectionLabel = "Access included automatically",
  selected,
  onChange,
  multiple,
  placeholder,
  searchPlaceholder = "Search people or teams...",
  emptyLabel = "No people or teams match",
  disabled = false,
  id,
  ariaLabel,
  maxSelections = 50,
  maxSelectionsByKind,
}: CommonProps & {
  selected: AccessSubjectRef[];
  onChange: (next: AccessSubjectRef[]) => void;
  multiple: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [remoteUsers, setRemoteUsers] = React.useState<AccessSubjectOption[]>([]);
  const [cachedUsers, setCachedUsers] = React.useState<AccessSubjectOption[]>([]);
  const [searching, setSearching] = React.useState(false);
  const listboxId = React.useId();

  React.useEffect(() => {
    if (!open || query.trim().length < 2) {
      setRemoteUsers([]);
      setSearching(false);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const response = await fetch(
          `/api/users/search?${new URLSearchParams({ q: query.trim() })}`,
          { signal: controller.signal },
        );
        if (!response.ok) {
          setRemoteUsers([]);
          return;
        }
        const payload = (await response.json()) as unknown;
        setRemoteUsers(
          userRows(payload).flatMap((user) => {
            const subject = user.subject?.trim();
            if (!subject) return [];
            const email = user.email?.trim() || null;
            return [{
              kind: "user" as const,
              id: subject,
              name: user.name?.trim() || email || "Unknown user",
              email,
            }];
          }),
        );
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setRemoteUsers([]);
        }
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 250);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, query]);

  const options = React.useMemo(() => {
    const all = [
      ...teamAccessOptions(teams),
      ...normalizeKnownUsers(knownUsers),
      ...cachedUsers,
      ...remoteUsers,
    ];
    const byKey = new Map<string, AccessSubjectOption>();
    for (const option of all) {
      const key = refKey(option);
      const current = byKey.get(key);
      if (!current || (!current.email && option.email)) byKey.set(key, option);
    }
    return [...byKey.values()];
  }, [cachedUsers, knownUsers, remoteUsers, teams]);

  const optionByKey = React.useMemo(
    () => new Map(options.map((option) => [refKey(option), option])),
    [options],
  );
  const selectedOptions = selected.map(
    (ref) => optionByKey.get(refKey(ref)) ?? {
      ...ref,
      name: ref.kind === "team" ? "Unknown team" : "Unknown user",
    },
  );
  const implicitOptions = implicitSelections
    .filter((ref) => !selected.some((selection) => sameRef(selection, ref)))
    .map(
      (ref) =>
        optionByKey.get(refKey(ref)) ?? {
          ...ref,
          name: ref.kind === "team" ? ref.id : "Unknown user",
        },
    );
  const displayedOptions = multiple
    ? [...selectedOptions, ...implicitOptions]
    : selectedOptions;

  const implicitLabelFor = React.useCallback(
    (ref: AccessSubjectRef) =>
      typeof implicitSelectionLabel === "function"
        ? implicitSelectionLabel(ref)
        : implicitSelectionLabel,
    [implicitSelectionLabel],
  );

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = options.filter((option) => {
      if (!needle) {
        return option.kind === "team" ||
          selected.some((ref) => sameRef(ref, option)) ||
          implicitSelections.some((ref) => sameRef(ref, option));
      }
      return [option.name, option.email, option.kind === "team" ? option.id : null]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLowerCase().includes(needle));
    });
    return matches.sort((left, right) => {
      const leftSelected = selected.some((ref) => sameRef(ref, left)) ||
        implicitSelections.some((ref) => sameRef(ref, left));
      const rightSelected = selected.some((ref) => sameRef(ref, right)) ||
        implicitSelections.some((ref) => sameRef(ref, right));
      if (leftSelected !== rightSelected) return leftSelected ? -1 : 1;
      if (left.kind !== right.kind) return left.kind === "user" ? -1 : 1;
      return displayName(left).localeCompare(displayName(right));
    });
  }, [implicitSelections, options, query, selected]);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };

  const remove = (ref: AccessSubjectRef, event?: React.MouseEvent) => {
    event?.stopPropagation();
    onChange(selected.filter((item) => !sameRef(item, ref)));
  };

  const pick = (option: AccessSubjectOption) => {
    const isSelected = selected.some((ref) => sameRef(ref, option));
    if (
      !isSelected &&
      implicitSelections.some((ref) => sameRef(ref, option))
    ) {
      return;
    }
    if (option.kind === "user") {
      setCachedUsers((current) => {
        const withoutCurrent = current.filter((user) => user.id !== option.id);
        return [...withoutCurrent, option];
      });
    }
    if (multiple) {
      if (isSelected) remove(option);
      else {
        const kindLimit = maxSelectionsByKind?.[option.kind] ?? maxSelections;
        const selectedOfKind = selected.filter((ref) => ref.kind === option.kind).length;
        if (selected.length < maxSelections && selectedOfKind < kindLimit) {
          onChange([...selected, { kind: option.kind, id: option.id }]);
        }
      }
      return;
    }
    onChange([{ kind: option.kind, id: option.id }]);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={listboxId}
          disabled={disabled}
          className={cn(
            "flex min-h-10 w-full items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-left text-sm",
            "hover:bg-muted/40 focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60",
          )}
        >
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {displayedOptions.length === 0 ? (
              <span className="text-muted-foreground">{placeholder}</span>
            ) : multiple ? (
              <>
                {displayedOptions.slice(0, 2).map((option) => {
                  const isImplicit = implicitOptions.some((candidate) =>
                    sameRef(candidate, option),
                  );
                  const inheritedFrom = isImplicit
                    ? implicitLabelFor(option)
                    : undefined;
                  return (
                  <Badge
                    key={refKey(option)}
                    variant={isImplicit ? "outline" : "secondary"}
                    className="max-w-72 gap-1"
                    title={inheritedFrom}
                  >
                    {option.kind === "user" ? <User className="h-3 w-3" /> : <Users className="h-3 w-3" />}
                    <span className="truncate">{displayName(option)}</span>
                    {inheritedFrom && (
                      <span className="truncate text-[10px] text-muted-foreground">
                        · {inheritedFrom}
                      </span>
                    )}
                    {!disabled && !isImplicit && (
                      <X
                        role="button"
                        aria-label={`Remove ${displayName(option)}`}
                        className="h-3 w-3 shrink-0"
                        onClick={(event) => remove(option, event)}
                      />
                    )}
                  </Badge>
                  );
                })}
                {displayedOptions.length > 2 && (
                  <span className="text-xs text-muted-foreground">+{displayedOptions.length - 2} more</span>
                )}
              </>
            ) : (
              <div className="flex min-w-0 items-center gap-2">
                {selectedOptions[0].kind === "user" ? <User className="h-4 w-4 shrink-0" /> : <Users className="h-4 w-4 shrink-0" />}
                <span className="truncate">{displayName(selectedOptions[0])}</span>
                {selectedOptions[0].email && selectedOptions[0].email !== displayName(selectedOptions[0]) && (
                  <span className="truncate text-xs text-muted-foreground">{selectedOptions[0].email}</span>
                )}
              </div>
            )}
          </div>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(420px,90vw)] p-0">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          {searching ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <Search className="h-4 w-4 text-muted-foreground" />
          )}
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={searchPlaceholder}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            autoFocus
            aria-label={searchPlaceholder}
          />
        </div>
        <div id={listboxId} role="listbox" className="max-h-64 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-3 py-4 text-xs text-muted-foreground">
              {query.trim().length < 2
                ? "Type at least 2 characters to find a person."
                : emptyLabel}
            </div>
          ) : (
            filtered.map((option) => {
              const isSelected = selected.some((ref) => sameRef(ref, option));
              const isImplicit = implicitSelections.some((ref) => sameRef(ref, option));
              const isImplicitOnly = isImplicit && !isSelected;
              const Icon = option.kind === "user" ? User : Users;
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected || isImplicit}
                  aria-disabled={isImplicitOnly}
                  disabled={isImplicitOnly}
                  key={refKey(option)}
                  onClick={() => pick(option)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 focus:bg-muted/50 focus:outline-none",
                    (isSelected || isImplicit) && "bg-muted/30",
                    isImplicitOnly && "cursor-not-allowed",
                  )}
                >
                  <Check className={cn("h-4 w-4 shrink-0", isSelected || isImplicit ? "text-primary" : "text-transparent")} />
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{displayName(option)}</p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {isImplicit
                        ? `${isSelected ? "Also " : ""}${implicitLabelFor(option) ?? "Included automatically"}`
                        : option.kind === "team"
                          ? `Team · ${option.id}`
                          : option.email ?? "Person"}
                    </p>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function AccessSubjectPicker({
  value,
  onChange,
  ...props
}: CommonProps & {
  value: AccessSubjectRef | null;
  onChange: (next: AccessSubjectRef) => void;
}) {
  return (
    <AccessSubjectPickerBase
      {...props}
      selected={value ? [value] : []}
      onChange={(next) => next[0] && onChange(next[0])}
      multiple={false}
    />
  );
}

export function AccessSubjectMultiPicker({
  selected,
  onChange,
  ...props
}: CommonProps & {
  selected: AccessSubjectRef[];
  onChange: (next: AccessSubjectRef[]) => void;
}) {
  return (
    <AccessSubjectPickerBase
      {...props}
      selected={selected}
      onChange={onChange}
      multiple
    />
  );
}
