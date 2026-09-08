"use client";

import { Button } from "@/components/ui/button";
import { AuthorizationSyncStatus } from "@/components/shared/AuthorizationSyncStatus";
import { Input } from "@/components/ui/input";
import {
  TeamMultiPicker,
  type TeamPickerOption,
} from "@/components/ui/team-picker";
import { cn } from "@/lib/utils";
import type { WorkflowConfigVisibility } from "@/types/workflow-config";
import type { AuthzSyncMetadata } from "@/types/authz-sync";
import {
  ArrowLeft,
  Copy,
  Download,
  Globe,
  Lock,
  Play,
  Save,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import YAML from "yaml";

interface Team {
  _id: string;
  slug: string;
  name: string;
}

interface WorkflowToolbarProps {
  name: string;
  description: string;
  onNameChange: (name: string) => void;
  onDescriptionChange: (description: string) => void;
  onSave: () => void;
  onBack: () => void;
  onRun?: () => void;
  onDelete?: () => void;
  onExport?: () => void;
  onImport?: (config: unknown) => void;
  isSaving: boolean;
  isEditing: boolean;
  hasUnsavedChanges?: boolean;
  stepCount: number;
  readOnly?: boolean;
  /** When true, Save creates a new editable workflow instead of updating in place */
  saveAsCopy?: boolean;
  /** Shown when readOnly — explains why Save is disabled */
  readOnlyHint?: string;
  onCloneToEdit?: () => void;
  visibility: WorkflowConfigVisibility;
  onVisibilityChange: (v: WorkflowConfigVisibility) => void;
  sharedWithTeams: string[];
  onSharedWithTeamsChange: (teams: string[]) => void;
  teams: Team[];
  authzDocument?: AuthzSyncMetadata | null;
}

const VISIBILITY_CONFIG: Record<
  WorkflowConfigVisibility,
  {
    icon: React.ReactNode;
    label: string;
    description: string;
    color: string;
  }
> = {
  private: {
    icon: <Lock className="h-3.5 w-3.5" />,
    label: "Private",
    description: "Only you can see this workflow",
    color: "text-amber-500",
  },
  team: {
    icon: <Users className="h-3.5 w-3.5" />,
    label: "Team",
    description: "Visible to selected teams",
    color: "text-blue-500",
  },
  global: {
    icon: <Globe className="h-3.5 w-3.5" />,
    label: "Global",
    description: "Visible to all users",
    color: "text-emerald-500",
  },
};

function VisibilityPopover({
  visibility,
  onVisibilityChange,
  sharedWithTeams,
  onSharedWithTeamsChange,
  teams,
  disabled,
}: {
  visibility: WorkflowConfigVisibility;
  onVisibilityChange: (v: WorkflowConfigVisibility) => void;
  sharedWithTeams: string[];
  onSharedWithTeamsChange: (teams: string[]) => void;
  teams: Team[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [dropdownCoords, setDropdownCoords] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const updateCoords = () => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setDropdownCoords({ top: rect.bottom + 4, left: rect.left });
    }
  };

  const handleOpen = () => {
    if (disabled) return;
    if (!open) updateCoords();
    setOpen((prev) => !prev);
  };

  // Close on click outside (both button and portal dropdown)
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        buttonRef.current?.contains(target) ||
        dropdownRef.current?.contains(target)
      )
        return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const config = VISIBILITY_CONFIG[visibility];

  const teamOptions = useMemo<TeamPickerOption[]>(
    () =>
      teams
        .filter((team): team is Team & { slug: string } => Boolean(team.slug))
        .map((team) => ({
          slug: team.slug,
          name: team.name,
          _id: team._id,
        })),
    [teams],
  );

  const dropdown =
    open && dropdownCoords
      ? createPortal(
          <div
            ref={dropdownRef}
            style={{
              position: "fixed",
              top: dropdownCoords.top,
              left: dropdownCoords.left,
            }}
            className="z-[200] w-72 rounded-lg border border-border bg-card shadow-lg p-2"
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            {(["global", "team", "private"] as WorkflowConfigVisibility[]).map(
              (v) => {
                const opt = VISIBILITY_CONFIG[v];
                return (
                  <button
                    key={v}
                    type="button"
                    onClick={() => {
                      onVisibilityChange(v);
                      if (v !== "team") setOpen(false);
                    }}
                    className={cn(
                      "w-full flex items-start gap-2.5 p-2 rounded-md text-left transition-colors",
                      visibility === v
                        ? "bg-primary/5 border border-primary/30"
                        : "hover:bg-muted/50 border border-transparent",
                    )}
                  >
                    <span className={cn("mt-0.5", VISIBILITY_CONFIG[v].color)}>
                      {opt.icon}
                    </span>
                    <div>
                      <div className="text-xs font-medium">{opt.label}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {opt.description}
                      </div>
                    </div>
                  </button>
                );
              },
            )}

            {visibility === "team" && (
              <div className="mt-2 pt-2 border-t border-border px-0.5">
                {teamOptions.length === 0 ? (
                  <p className="text-[10px] text-muted-foreground italic px-1">
                    No teams available.
                  </p>
                ) : (
                  <TeamMultiPicker
                    options={teamOptions}
                    selected={sharedWithTeams}
                    onChange={onSharedWithTeamsChange}
                    disabled={disabled}
                    ariaLabel="Share workflow with teams"
                    placeholder="Share with teams…"
                    searchPlaceholder="Search teams…"
                    emptyLabel="No teams match"
                    triggerChipCap={1}
                    contentClassName="z-[210]"
                  />
                )}
              </div>
            )}
          </div>,
          document.body,
        )
      : null;

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={handleOpen}
        disabled={disabled}
        className={cn(
          "flex items-center gap-1.5 h-8 px-2.5 rounded-md border text-xs font-medium transition-colors",
          "hover:bg-muted/50",
          disabled && "opacity-50 cursor-not-allowed",
          config.color,
        )}
        title={`Visibility: ${config.label}`}
      >
        {config.icon}
        <span className="hidden sm:inline">{config.label}</span>
      </button>

      {dropdown}
    </div>
  );
}

export function WorkflowToolbar({
  name,
  description,
  onNameChange,
  onDescriptionChange,
  onSave,
  onBack,
  onRun,
  onDelete,
  onExport,
  onImport,
  isSaving,
  isEditing,
  hasUnsavedChanges = false,
  stepCount,
  readOnly,
  saveAsCopy,
  readOnlyHint,
  onCloneToEdit,
  visibility,
  onVisibilityChange,
  sharedWithTeams,
  onSharedWithTeamsChange,
  teams,
  authzDocument,
}: WorkflowToolbarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !onImport) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const text = ev.target?.result as string;
        // Try YAML first (also handles JSON since JSON is valid YAML)
        const parsed = YAML.parse(text);
        onImport(parsed);
      } catch {
        console.error("Invalid YAML/JSON file");
      }
    };
    reader.readAsText(file);
    // Reset so same file can be re-imported
    e.target.value = "";
  };

  return (
    <div className="px-4 py-3 border-b border-border bg-card/80 backdrop-blur-sm shrink-0">
      {/* Single row: Back | Name & Desc | Actions */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="gap-1.5 h-8 px-2.5 shrink-0"
        >
          <ArrowLeft className="h-4 w-4" />
          Exit
        </Button>

        <div className="h-5 w-px bg-border shrink-0" />

        {/* Name & description fields */}
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className="flex flex-col gap-0.5 min-w-[160px] max-w-[260px]">
            <label className="text-[10px] text-muted-foreground font-medium leading-none">
              Workflow Name
            </label>
            <Input
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              placeholder="Workflow name..."
              className="h-8 text-sm font-semibold"
              readOnly={readOnly}
            />
          </div>

          <div className="flex flex-col gap-0.5 min-w-[140px] max-w-[320px] flex-1">
            <label className="text-[10px] text-muted-foreground font-medium leading-none">
              Description
            </label>
            <Input
              value={description}
              onChange={(e) => onDescriptionChange(e.target.value)}
              placeholder="Description (optional)"
              className="h-8 text-sm"
              readOnly={readOnly}
            />
          </div>
        </div>

        {/* Step count badge */}
        <span className="text-xs text-muted-foreground font-mono shrink-0 bg-muted/50 px-2 py-0.5 rounded">
          {stepCount} step{stepCount !== 1 ? "s" : ""}
        </span>

        {hasUnsavedChanges && (
          <span
            className="text-xs font-medium shrink-0 px-2 py-0.5 rounded border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
            title="Save your workflow before leaving the editor"
          >
            Unsaved
          </span>
        )}

        {/* Visibility button */}
        <VisibilityPopover
          visibility={visibility}
          onVisibilityChange={onVisibilityChange}
          sharedWithTeams={sharedWithTeams}
          onSharedWithTeamsChange={onSharedWithTeamsChange}
          teams={teams}
          disabled={readOnly}
        />
        <AuthorizationSyncStatus
          document={authzDocument}
          busy={isSaving}
          canRetry={!readOnly}
        />

        <div className="h-5 w-px bg-border shrink-0" />

        {/* Action buttons */}
        <div className="flex items-center gap-2 shrink-0">
          {onExport && (
            <Button
              variant="outline"
              size="sm"
              onClick={onExport}
              className="gap-1.5 h-8 text-xs px-3"
              title="Download workflow as YAML"
            >
              <Upload className="h-3.5 w-3.5" />
              Export
            </Button>
          )}
          {onImport && !readOnly && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={handleImportClick}
                className="gap-1.5 h-8 text-xs px-3"
                title="Upload workflow YAML"
              >
                <Download className="h-3.5 w-3.5" />
                Import
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".yaml,.yml,.json"
                className="hidden"
                onChange={handleFileChange}
              />
            </>
          )}

          {onDelete && isEditing && !readOnly && (
            <Button
              variant="outline"
              size="sm"
              onClick={onDelete}
              className="gap-1.5 h-8 text-xs px-3 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </Button>
          )}

          {onRun && isEditing && (
            <Button
              variant="outline"
              size="sm"
              onClick={onRun}
              disabled={stepCount === 0}
              className="gap-1.5 h-8 text-xs px-3 border-primary/30 text-primary hover:bg-primary/10"
            >
              <Play className="h-3.5 w-3.5" />
              Run
            </Button>
          )}

          {readOnly && onCloneToEdit && (
            <Button
              variant="outline"
              size="sm"
              onClick={onCloneToEdit}
              className="gap-1.5 h-8 text-xs px-3 border-primary/30 text-primary hover:bg-primary/10"
            >
              <Copy className="h-3.5 w-3.5" />
              Clone to edit
            </Button>
          )}

          <Button
            size="sm"
            onClick={onSave}
            disabled={
              isSaving || !name || stepCount === 0 || (readOnly && !saveAsCopy)
            }
            title={readOnly && !saveAsCopy ? readOnlyHint : undefined}
            className="gap-1.5 h-8 text-xs px-4 gradient-primary text-white disabled:opacity-40"
          >
            <Save className="h-3.5 w-3.5" />
            {isSaving ? "Saving..." : saveAsCopy ? "Save as copy" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
