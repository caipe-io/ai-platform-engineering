"use client";

/**
 * ReviewConfigsTab — Admin workspace editor for AI Review configuration.
 *
 * The set of review targets is fixed in code (see
 * `lib/server/ai-review/defaults.ts`); this tab renders one nested tab per
 * target, each a `ReviewConfigEditor` pinned to that target. Adding a new
 * surface is a code change — the admin can't coin arbitrary targets, which
 * keeps the UI focused and matches how AI Suggest's task registry works.
 */

import { SaveButton } from "@/components/admin/shared/SaveButton";
import { Tabs,TabsContent,TabsList,TabsTrigger } from "@/components/ui/tabs";
import { useSubtabParam } from "@/hooks/use-subtab-param";
import { BookOpen,Bot,ShieldCheck } from "lucide-react";
import * as React from "react";
import { ReviewConfigEditor,type ReviewConfigEditorHandle } from "./ReviewConfigEditor";

interface TargetTab {
  /** Mongo `_id` / `target` for the pinned editor. */
  target: string;
  /** Tab label. */
  label: string;
  /** Helper text under the page header. */
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
}

const TARGETS: TargetTab[] = [
  {
    target: "agent-system-prompt",
    label: "Agents",
    hint: "Used by the Agent editor's Instructions step.",
    icon: Bot,
  },
  {
    target: "skill-md",
    label: "Skills",
    hint: "Used by the Skill workspace's Files step.",
    icon: BookOpen,
  },
];

const TARGET_VALUES: readonly string[] = TARGETS.map((t) => t.target);

export function ReviewConfigsTab({ readOnly = false }: { readOnly?: boolean }) {
  // Active target is mirrored to the `subtab` URL param so the chosen review
  // config (Agents / Skills) is deep-linkable and survives refresh.
  const [activeTarget, setActiveTarget] = useSubtabParam(TARGET_VALUES, TARGETS[0].target);
  const [savingByTarget, setSavingByTarget] = React.useState<Record<string, boolean>>({});
  const [readyByTarget, setReadyByTarget] = React.useState<Record<string, boolean>>({});
  const [dirtyByTarget, setDirtyByTarget] = React.useState<Record<string, boolean>>({});
  const editorRefs = React.useRef<Record<string, ReviewConfigEditorHandle | null>>({});
  const activeSaving = savingByTarget[activeTarget] ?? false;
  const activeReady = readyByTarget[activeTarget] ?? false;
  const activeDirty = dirtyByTarget[activeTarget] ?? false;

  const setTargetSaving = React.useCallback((target: string, saving: boolean) => {
    setSavingByTarget((previous) =>
      previous[target] === saving ? previous : { ...previous, [target]: saving },
    );
  }, []);

  const setTargetReady = React.useCallback((target: string, ready: boolean) => {
    setReadyByTarget((previous) =>
      previous[target] === ready ? previous : { ...previous, [target]: ready },
    );
  }, []);

  const setTargetDirty = React.useCallback((target: string, dirty: boolean) => {
    setDirtyByTarget((previous) =>
      previous[target] === dirty ? previous : { ...previous, [target]: dirty },
    );
  }, []);

  return (
    <div className="space-y-4">
      <div
        role="region"
        aria-label="AI Review configurations header"
        className="flex flex-wrap items-start justify-between gap-3"
      >
        <div>
          <h3 className="text-base font-semibold flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" />
            AI Review configurations
          </h3>
          <p className="text-xs text-muted-foreground">
            Edit the rubric that grades content before save in each consumer
            flow. Built-in defaults are seeded automatically on first edit.
          </p>
        </div>
        <SaveButton
          onSave={() => editorRefs.current[activeTarget]?.save()}
          saving={activeSaving}
          dirty={activeDirty}
          disabled={readOnly || !activeReady}
        />
      </div>

      <Tabs value={activeTarget} onValueChange={setActiveTarget} className="w-full">
        <TabsList>
          {TARGETS.map(({ target, label, icon: Icon }) => (
            <TabsTrigger
              key={target}
              value={target}
              className="gap-2"
              onClick={() => setActiveTarget(target)}
            >
              <Icon className="h-4 w-4" />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>

        {TARGETS.map(({ target, hint }) => (
          <TabsContent key={target} value={target} className="space-y-3 pt-3">
            <p className="text-xs text-muted-foreground">{hint}</p>
            <ReviewConfigEditor
              ref={(instance) => {
                editorRefs.current[target] = instance;
              }}
              target={target}
              readOnly={readOnly}
              showInlineSave={false}
              onSavingChange={(saving) => setTargetSaving(target, saving)}
              onReadyChange={(ready) => setTargetReady(target, ready)}
              onDirtyChange={(dirtyValue) => setTargetDirty(target, dirtyValue)}
            />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
