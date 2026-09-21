"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchablePicker } from "@/components/ui/searchable-picker";
import { cn } from "@/lib/utils";
import type { AgentSkill,ScanStatus } from "@/types/agent-skill";
import {
AlertCircle,
CheckSquare,
Loader2,
Lock,
Plus,
Sparkles,
Tag,
TriangleAlert,
X,
} from "lucide-react";
import React from "react";

/**
 * Mirrors ``isFlaggedSkill`` in ``components/skills/SkillsGallery.tsx``
 * and the bash filters in ``install.sh``: a skill the security scanner
 * has flagged AND that no admin has green-lit must never be runnable,
 * addable to an agent, or installed by the bulk script.
 *
 * The override is read from the separate ``scan_override`` sub-doc
 * (presence = active override). The catalog API also stamps
 * ``runnable: true`` for overridden flagged skills via
 * ``applyRunnableGate``; this predicate is the UI mirror so the
 * picker doesn't optimistically disable the row before the API
 * stamp lands. See the ``isFlaggedSkill`` doc-string in
 * ``SkillsGallery.tsx`` for the design rationale.
 */
function isFlaggedSkill(skill: AgentSkill): boolean {
  if (skill.scan_status !== "flagged") return false;
  if (skill.scan_override) return false;
  return true;
}

interface SkillsSelectorProps {
  value: string[];
  onChange: (skillIds: string[]) => void;
  disabled?: boolean;
  maxSkills?: number;
}

const DEFAULT_MAX_SKILLS = 500;

export function SkillsSelector({ value, onChange, disabled, maxSkills = DEFAULT_MAX_SKILLS }: SkillsSelectorProps) {
  const [availableSkills, setAvailableSkills] = React.useState<AgentSkill[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState("");
  const [categoryFilter, setCategoryFilter] = React.useState<string | null>(null);
  const [tagFilters, setTagFilters] = React.useState<Set<string>>(new Set());

  // Fetch available skills on mount
  React.useEffect(() => {
    fetchSkills();
  }, []);

  async function fetchSkills() {
    setLoading(true);
    setError(null);
    try {
      // Use the unified skills catalog (/api/skills) which merges
      // default (filesystem), agent_skills (MongoDB), and hub skills.
      const response = await fetch("/api/skills");
      const data = await response.json();
      if (data.error) {
        setError(data.error);
        return;
      }
      const catalogSkills: Array<{
        id: string;
        name: string;
        description: string;
        source: string;
        source_id: string | null;
        content: string | null;
        metadata: Record<string, unknown>;
        // The listing route stamps these via applyRunnableGate. They
        // were silently dropped from the AgentSkill projection here
        // before the security-gate fix, which let flagged skills be
        // attached to custom agents (mirror of the install.sh leak).
        scan_status?: ScanStatus;
        runnable?: boolean;
        blocked_reason?: string;
      }> = data.skills ?? [];
      // Map CatalogSkill → AgentSkill shape used by this component
      const skills: AgentSkill[] = catalogSkills.map((cs) => ({
        id: cs.id,
        name: cs.name,
        description: cs.description,
        category: (cs.metadata?.category as string) || cs.source,
        tasks: [],
        owner_id: "",
        is_system: cs.source !== "agent_skills" || !!(cs.metadata?.is_system),
        created_at: new Date(),
        updated_at: new Date(),
        visibility: (cs.metadata?.visibility as AgentSkill["visibility"]) || "global",
        metadata: {
          tags: Array.isArray(cs.metadata?.tags) ? cs.metadata.tags as string[] : [],
          ...(cs.source === "hub" ? { hub_type: cs.metadata?.hub_type as string } : {}),
        },
        skill_content: cs.content ?? undefined,
        // Preserve scan_status so the picker can dim + disable flagged
        // skills. Without this the picker treated everything as
        // runnable, mirroring the install.sh leak.
        scan_status: cs.scan_status,
      }));
      setAvailableSkills(skills);
    } catch {
      setError("Failed to load skills");
    } finally {
      setLoading(false);
    }
  }

  // Extract unique categories and tags for filter dropdowns
  const categories = React.useMemo(() => {
    const cats = new Set<string>();
    for (const s of availableSkills) {
      if (s.category) cats.add(s.category);
    }
    return Array.from(cats).sort();
  }, [availableSkills]);

  const tags = React.useMemo(() => {
    const t = new Set<string>();
    for (const s of availableSkills) {
      for (const tag of s.metadata?.tags ?? []) {
        t.add(tag);
      }
    }
    return Array.from(t).sort();
  }, [availableSkills]);

  // Filter by search, category, and tags
  const filtered = React.useMemo(() => {
    return availableSkills.filter((s) => {
      // Exclude already-selected skills from the "available" list
      if (value.includes(s.id)) return false;

      if (categoryFilter && s.category !== categoryFilter) return false;
      if (tagFilters.size > 0) {
        const skillTags = s.metadata?.tags ?? [];
        if (!Array.from(tagFilters).some((t) => skillTags.includes(t))) return false;
      }

      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return (
        s.name.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q) ||
        (s.description && s.description.toLowerCase().includes(q)) ||
        (s.category && s.category.toLowerCase().includes(q))
      );
    });
  }, [availableSkills, search, categoryFilter, tagFilters, value]);

  // Selected skills resolved to full objects
  const selectedSkills = React.useMemo(() => {
    const byId = new Map(availableSkills.map((s) => [s.id, s]));
    return value.map((id) => byId.get(id)).filter(Boolean) as AgentSkill[];
  }, [availableSkills, value]);

  const atLimit = value.length >= maxSkills;

  function addSkill(skillId: string) {
    const candidate = availableSkills.find((s) => s.id === skillId);
    // Refuse to add flagged skills even if a caller bypasses the
    // disabled button (e.g. clicks the row label, or a future refactor
    // wires up keyboard activation). Mirrors handleConfigClick in
    // SkillsGallery.tsx and the install.sh bash filters.
    if (candidate && isFlaggedSkill(candidate)) return;
    if (!value.includes(skillId) && !atLimit) {
      onChange([...value, skillId]);
    }
  }

  function removeSkill(skillId: string) {
    onChange(value.filter((id) => id !== skillId));
  }

  function selectAllFiltered() {
    const existing = new Set(value);
    // Skip flagged skills in bulk-add too -- otherwise "Select all"
    // would silently re-introduce the security leak the install.sh
    // filter is supposed to plug.
    for (const s of filtered) {
      if (existing.size >= maxSkills) break;
      if (isFlaggedSkill(s)) continue;
      existing.add(s.id);
    }
    onChange(Array.from(existing));
  }

  function clearFilters() {
    setSearch("");
    setCategoryFilter(null);
    setTagFilters(new Set());
  }

  const hasActiveFilters = search || categoryFilter || tagFilters.size > 0;

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">Loading skills...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 text-destructive py-4">
        <AlertCircle className="h-4 w-4" />
        <span className="text-sm">{error}</span>
      </div>
    );
  }

  if (availableSkills.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <Sparkles className="h-8 w-8 mx-auto mb-2 opacity-50" />
        <p className="text-sm">No skills available.</p>
        <p className="text-xs mt-1">Create skills in the Skills tab first.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── Selected skills ── */}
      {selectedSkills.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Selected Skills</Label>
            <Badge variant="default" className="text-xs">
              {value.length} selected
            </Badge>
          </div>

          {/* Tiered warnings */}
          {value.length > maxSkills && (
            <div className="flex items-start gap-2 rounded-md bg-destructive/10 border border-destructive/30 px-3 py-2">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 text-destructive shrink-0" />
              <p className="text-xs text-destructive">
                Maximum {maxSkills} skills allowed. Remove {value.length - maxSkills} skill
                {value.length - maxSkills !== 1 ? "s" : ""} to save.
              </p>
            </div>
          )}
          {value.length > 20 && value.length <= maxSkills && (
            <div className="flex items-start gap-2 rounded-md bg-amber-500/10 border border-amber-500/30 px-3 py-2">
              <TriangleAlert className="h-3.5 w-3.5 mt-0.5 text-amber-600 dark:text-amber-400 shrink-0" />
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Too many skills can dilute agent focus. Consider selecting only the most relevant ones.
              </p>
            </div>
          )}

          <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto border rounded-lg p-2">
            {selectedSkills.map((skill) => {
              // A skill the user attached BEFORE it was flagged stays
              // in `value` -- the picker can't quietly drop it (that
              // would silently mutate the agent's saved skill list).
              // Render it with a red outline + lock icon so the user
              // knows the next save will leave the agent attached to
              // a non-runnable skill, and trigger them to remove it.
              const flagged = isFlaggedSkill(skill);
              return (
                <Badge
                  key={skill.id}
                  variant={flagged ? "outline" : "secondary"}
                  className={cn(
                    "text-xs px-2 py-0.5 gap-1 cursor-pointer hover:bg-destructive/10 hover:text-destructive transition-colors",
                    flagged && "bg-red-500/10 text-red-600 border-red-500/30",
                  )}
                  title={
                    flagged
                      ? "This skill is flagged by the security scanner. Remove it; the agent will fail to load it at runtime."
                      : undefined
                  }
                  onClick={() => !disabled && removeSkill(skill.id)}
                >
                  {flagged && <Lock className="h-2.5 w-2.5" />}
                  {skill.name}
                  <X className="h-3 w-3" />
                </Badge>
              );
            })}
            {/* Show IDs that don't resolve (orphaned references) */}
            {value
              .filter((id) => !availableSkills.some((s) => s.id === id))
              .map((id) => (
                <Badge
                  key={id}
                  variant="outline"
                  className="text-xs px-2 py-0.5 gap-1 cursor-pointer text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                  onClick={() => !disabled && removeSkill(id)}
                >
                  {id}
                  <X className="h-3 w-3" />
                </Badge>
              ))}
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => !disabled && onChange([])}
              disabled={disabled}
              className="text-xs text-muted-foreground hover:text-destructive transition-colors underline underline-offset-2"
            >
              Clear all
            </button>
          </div>
        </div>
      )}

      {/* ── Add skills section ── */}
      <div className="space-y-2">
        <Label>Add Skills</Label>

        {/* Search + filters — all on one row */}
        <div className="flex items-center gap-2 flex-wrap">
          <Input
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-7 text-xs w-64"
            disabled={disabled}
          />
          {categories.length > 1 && (
            <div className="w-40">
              <SearchablePicker
                options={categories}
                selected={categoryFilter ?? undefined}
                onSelect={setCategoryFilter}
                getOptionKey={(category) => category}
                getOptionLabel={(category) => category}
                placeholder="All categories"
                searchPlaceholder="Search categories..."
                emptyLabel="No categories match"
                ariaLabel="Skill category filter"
                disabled={disabled}
                onClear={() => setCategoryFilter(null)}
                clearLabel="Clear category filter"
                triggerClassName="h-7 px-2 text-xs"
              />
            </div>
          )}
          {tags.length > 0 && (
            <div className="w-40">
              <SearchablePicker
                options={tags.filter((tag) => !tagFilters.has(tag))}
                onSelect={(tag) =>
                  setTagFilters((previous) => new Set([...previous, tag]))
                }
                getOptionKey={(tag) => tag}
                getOptionLabel={(tag) => tag}
                placeholder="Add tag filter..."
                searchPlaceholder="Search tags..."
                emptyLabel="No more tags available"
                ariaLabel="Add skill tag filter"
                disabled={disabled}
                triggerClassName="h-7 px-2 text-xs"
              />
            </div>
          )}
          {hasActiveFilters && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clearFilters}
              className="h-7 text-xs px-2"
            >
              Clear
            </Button>
          )}
          {filtered.length > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={selectAllFiltered}
              disabled={disabled || atLimit}
              className="h-7 text-xs px-2 ml-auto"
            >
              <CheckSquare className="h-3 w-3 mr-1" />
              Select {hasActiveFilters ? "filtered" : "all"} ({filtered.length})
            </Button>
          )}
        </div>

        {/* Active tag filter chips */}
        {tagFilters.size > 0 && (
          <div className="flex items-center gap-1 flex-wrap">
            {Array.from(tagFilters).map((tag) => (
              <Badge
                key={tag}
                variant="secondary"
                className="text-[10px] px-1.5 py-0 gap-1 cursor-pointer hover:bg-destructive/10 hover:text-destructive transition-colors"
                onClick={() =>
                  setTagFilters((prev) => {
                    const next = new Set(prev);
                    next.delete(tag);
                    return next;
                  })
                }
              >
                <Tag className="h-2.5 w-2.5" />
                {tag}
                <X className="h-2.5 w-2.5" />
              </Badge>
            ))}
          </div>
        )}

        {/* Available skills list — compact single-line rows */}
        <div className="max-h-96 overflow-y-auto border rounded-lg p-1">
          {filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              {hasActiveFilters
                ? "No skills match current filters"
                : "All skills have been selected"}
            </p>
          ) : (
            filtered.map((skill) => {
              // Flagged skills stay visible (admins need to know they
              // exist + can re-scan from the Skills tab), but are
              // dimmed, non-clickable, and badged so the user can't
              // accidentally attach an unsafe skill to an agent.
              const flagged = isFlaggedSkill(skill);
              return (
                <button
                  key={skill.id}
                  type="button"
                  onClick={() => addSkill(skill.id)}
                  disabled={disabled || atLimit || flagged}
                  title={
                    flagged
                      ? "Disabled — security scan flagged this skill. Re-scan after fixing SKILL.md to restore."
                      : undefined
                  }
                  className={cn(
                    "flex items-start gap-2 w-full px-2 py-1.5 rounded-md text-left transition-colors",
                    !flagged && "hover:bg-muted cursor-pointer",
                    (disabled || atLimit) && "opacity-50 cursor-not-allowed",
                    flagged && "opacity-60 cursor-not-allowed",
                  )}
                >
                  {flagged ? (
                    <Lock className="h-3 w-3 text-red-500 flex-shrink-0 mt-1" />
                  ) : (
                    <Plus className="h-3 w-3 text-muted-foreground flex-shrink-0 mt-1" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium truncate">{skill.name}</span>
                      {skill.category && (
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 flex-shrink-0">
                          {skill.category}
                        </Badge>
                      )}
                      {skill.visibility && skill.visibility !== "private" && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 flex-shrink-0">
                          {skill.visibility}
                        </Badge>
                      )}
                      {flagged && (
                        <Badge
                          variant="outline"
                          className="text-[10px] px-1.5 py-0 gap-1 bg-red-500/10 text-red-600 border-red-500/30 flex-shrink-0"
                        >
                          <Lock className="h-2.5 w-2.5" />
                          Disabled — flagged
                        </Badge>
                      )}
                    </div>
                    {skill.description && (
                      <p className="text-xs text-muted-foreground truncate">{skill.description}</p>
                    )}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Help text */}
      {value.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Skills inject domain-specific instructions into the agent&apos;s context via progressive disclosure.
        </p>
      )}
    </div>
  );
}
