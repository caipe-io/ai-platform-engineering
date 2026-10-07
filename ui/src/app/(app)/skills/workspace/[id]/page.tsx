"use client";

import { useRouter,useSearchParams } from "next/navigation";
import { use,useEffect,useMemo,useState } from "react";

import { AuthGuard } from "@/components/auth-guard";
import {
SkillWorkspace,
type SkillWorkspaceTabId,
} from "@/components/skills/workspace/SkillWorkspace";
import { CAIPESpinner } from "@/components/ui/caipe-spinner";
import {
mapCatalogSkillToAgentSkill,
type CatalogSkillForUi,
} from "@/lib/catalog-skill-mapping";
import { useAgentSkillsStore } from "@/store/agent-skills-store";
import type { AgentSkill } from "@/types/agent-skill";

// ---------------------------------------------------------------------------
// /skills/workspace/[id]
//
// Loads the named skill from the global store (or falls back to a one-shot
// API fetch) and mounts <SkillWorkspace>. The "new" pseudo-id renders the
// workspace in create mode (no `existingConfig`).
//
// Query params:
//   ?tab=files|overview|tools|history  — canonical tab ids
//   ?tab=variables                     — legacy, remaps to `files`
//                                        (Variables editor was folded
//                                        into the Files step as a
//                                        collapsible side-panel)
//   ?tab=scan                          — alias for `history`
//                                        (the step is now
//                                        labelled "Scan skill")
//   ?tab=test                          — legacy, remaps to
//                                        Overview (Test tab
//                                        was removed)
//   ?backHref=/path                    — override Back link
// ---------------------------------------------------------------------------

const VALID_TABS: SkillWorkspaceTabId[] = [
  "overview",
  "files",
  "tools",
  "versions",
  "history",
];

/**
 * Aliases accepted from the URL but not in the canonical id list.
 *   - `test`: legacy Test tab → Overview (tab was removed in the wizard
 *     redesign; running a skill happens from the gallery now).
 *   - `variables`: legacy Variables tab → Files (the variables editor
 *     is now a collapsible side-panel inside the Files step).
 *   - `scan`: matches the new "Scan skill" label so users typing the
 *     visible name don't 404 themselves; we keep the canonical id as
 *     `history` for backward-compat with existing bookmarks.
 */
const LEGACY_TAB_REMAP: Record<string, SkillWorkspaceTabId> = {
  test: "overview",
  variables: "files",
  scan: "history",
};

export default function SkillWorkspacePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();

  const isNew = id === "new";
  const tabParam = searchParams.get("tab");
  const initialTab: SkillWorkspaceTabId = useMemo(() => {
    if (tabParam) {
      if ((VALID_TABS as string[]).includes(tabParam)) {
        return tabParam as SkillWorkspaceTabId;
      }
      const remapped = LEGACY_TAB_REMAP[tabParam];
      if (remapped) return remapped;
    }
    return isNew ? "overview" : "files";
  }, [tabParam, isNew]);
  const backHref = searchParams.get("backHref") || "/skills";

  const {
    configs,
    isLoading,
    loadSkills,
    getSkillById,
  } = useAgentSkillsStore();
  const [skill, setSkill] = useState<AgentSkill | undefined>(undefined);
  const [ready, setReady] = useState(isNew);
  const [notFound, setNotFound] = useState(false);

  // Lazy-load the store if empty.
  useEffect(() => {
    if (!isNew && configs.length === 0 && !isLoading) {
      loadSkills();
    }
  }, [isNew, configs.length, isLoading, loadSkills]);

  // Resolve the skill once the store is populated.
  //
  // The store only carries persisted Mongo `agent_skills` rows. The Skills
  // Gallery, however, also surfaces catalog-only entries from `/api/skills`
  // — built-in chart templates (`charts/data/skills/*/SKILL.md`) and hub /
  // GitHub-crawled skills — and prefixes their IDs with `catalog-`. Those
  // IDs will never appear in `configs`, so without a fallback the workspace
  // would always render "We couldn't find a skill with that id." for every
  // built-in template. To fix that, we fall back to a one-shot fetch
  // against the unified `/api/skills?include_content=true` catalog and map
  // the response into an `AgentSkill` shape compatible with the workspace
  // (matching `SkillsGallery`'s mapping for `catalog-*` IDs).
  useEffect(() => {
    if (isNew) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: initialize ready state for new skills
      setReady(true);
      return;
    }
    if (isLoading) return;
    const found = getSkillById(id);
    if (found) {

      setSkill(found);
      setNotFound(false);
      setReady(true);
      return;
    }

    // Fallback: try the catalog endpoint for `catalog-<source-id>` rows
    // (built-in templates, hub-crawled skills). Strips the `catalog-` prefix
    // and asks the API for the full SKILL.md body so the editor isn't blank.
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(
          "/api/skills?include_content=true",
          { credentials: "include", signal: controller.signal },
        );
        if (!res.ok) {
          if (!cancelled) {
            setNotFound(true);
            setReady(true);
          }
          return;
        }
        const data = (await res.json()) as {
          skills?: CatalogSkillForUi[];
        };
        const wanted = id.startsWith("catalog-") ? id.slice("catalog-".length) : id;
        const match = data.skills?.find((s) => s.id === wanted || `catalog-${s.id}` === id);
        if (!match) {
          if (!cancelled) {
            setNotFound(true);
            setReady(true);
          }
          return;
        }
        const mapped = mapCatalogSkillToAgentSkill(match);
        if (!cancelled) {
          setSkill(mapped);
          setNotFound(false);
          setReady(true);
        }
      } catch {
        if (!cancelled) {
          setNotFound(true);
          setReady(true);
        }
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [id, isNew, configs, getSkillById, isLoading]);

  // Built-in / hub skills are read-only — surface that explicitly. We
  // derive the source from the unified catalog metadata since `AgentSkill`
  // itself doesn't carry a top-level `source` field.
  //
  // IMPORTANT: this `useMemo` MUST stay above the early `return`s below.
  // React's Rules of Hooks require the same number of hooks per render,
  // and the loading/notFound branches return before this hook ran in
  // earlier code, which produced a "change in the order of Hooks" warning
  // the first time `ready` flipped to true.
  const readOnly = useMemo(() => {
    if (!skill) return false;
    const src =
      (skill.metadata as { catalog_source?: string } | undefined)
        ?.catalog_source;
    if (src === "hub" || src === "default") return true;
    if (skill.is_system) return true;
    return false;
  }, [skill]);

  if (!ready || (isLoading && configs.length === 0)) {
    return (
      <AuthGuard>
        <div className="flex h-[calc(100vh-4rem)] items-center justify-center">
          <CAIPESpinner size="lg" message="Loading workspace…" />
        </div>
      </AuthGuard>
    );
  }

  if (notFound) {
    return (
      <AuthGuard>
        <div className="flex h-[calc(100vh-4rem)] flex-col items-center justify-center gap-3">
          <p className="text-sm text-muted-foreground">
            We couldn&apos;t find a skill with that id.
          </p>
          <button
            type="button"
            className="text-sm underline text-primary"
            onClick={() => router.push(backHref)}
          >
            Back to Skills
          </button>
        </div>
      </AuthGuard>
    );
  }

  return (
    <AuthGuard>
      <div className="h-[calc(100vh-4rem)]">
        <SkillWorkspace
          existingConfig={skill}
          initialTab={initialTab}
          backHref={backHref}
          readOnly={readOnly}
        />
      </div>
    </AuthGuard>
  );
}
