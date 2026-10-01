/**
 * Agent skill types (catalog source: agent_skills)
 * 
 * These types define the structure for both:
 * - Agent workflows with multiple tasks (based on task_config.yaml)
 * - Quick-start templates (formerly "Use Cases") - single-step prompts
 */

/**
 * Difficulty level for workflows
 */
export type WorkflowDifficulty = "beginner" | "intermediate" | "advanced";

/**
 * Visibility level for skills
 *
 * - "private":  Only the owner can see and use this skill
 * - "team":     Owner + members of teams granted in OpenFGA can see it
 * - "global":   All authenticated users can see it
 */
export type SkillVisibility = "private" | "team" | "global";

/**
 * Input field for user forms (used in quick-start templates)
 */
export interface WorkflowInputField {
  name: string;
  label: string;
  placeholder: string;
  type: "text" | "url" | "number";
  required?: boolean;
  defaultValue?: string;
  helperText?: string;
}

/**
 * Input form configuration for workflows with placeholders
 */
export interface WorkflowInputForm {
  title: string;
  description?: string;
  fields: WorkflowInputField[];
  submitLabel?: string;
}

/**
 * A single task step within an agent skill
 */
export interface AgentSkillTask {
  /** UI label displayed for this step */
  display_text: string;
  /** LLM prompt template with {variable} or {{variable}} placeholders for substitution */
  llm_prompt: string;
  /** Target subagent to execute this task (caipe, github, aws, argocd, aigateway, webex, jira) */
  subagent: AgentSkillSubagent;
}

/**
 * Available subagent types that can execute tasks
 */
export type AgentSkillSubagent = 
  | "user_input"  // User input collection via forms
  | "github"    // GitHub operations via gh CLI
  | "aws"       // AWS resource provisioning
  | "argocd"    // ArgoCD deployments
  | "aigateway" // LLM API key management
  | "webex"     // Webex notifications
  | "jira"      // Jira ticket operations
  | string;     // Allow custom subagents

/**
 * Categories for organizing agent skills
 */
export type AgentSkillCategory =
  | "GitHub Operations"
  | "AWS Operations"
  | "ArgoCD Operations"
  | "AI Gateway Operations"
  | "Group Management"
  | "DevOps"
  | "Development"
  | "Operations"
  | "Cloud"
  | "Project Management"
  | "Security"
  | "Infrastructure"
  | "Knowledge"
  | "Custom";

/**
 * Metadata for an agent skill
 */
/** An input variable definition for the "Try Skill" parameter form. */
export interface SkillInputVariable {
  name: string;
  label: string;
  required: boolean;
  placeholder?: string;
}

export interface AgentSkillMetadata {
  /** Environment variables required for this skill to work */
  env_vars_required?: string[];
  /** Estimated duration for the workflow (e.g., "2-5 minutes") */
  estimated_duration?: string;
  /** Version of the skill schema */
  schema_version?: string;
  /** Tags for filtering/searching */
  tags?: string[];
  /** Expected agents/integrations used (for display) */
  expected_agents?: string[];
  /** (Experimental) Tool allowlist for this skill -- not enforced by backend yet */
  allowed_tools?: string[];
  /** Input variables shown in the Try Skill modal when skill has no {{var}} in prompt */
  input_variables?: SkillInputVariable[];
  /** Packaged template id when row was imported from chart/disk templates */
  template_source_id?: string;
  /** Provenance for template import (e.g. helm chart) */
  import_kind?: string;
}

/**
 * Scan status produced by the skill-scanner service (FR-027).
 *
 * The scanner only ever emits one of these three values, and that
 * is also the only value persisted on the doc — the admin override
 * is a SEPARATE field (``scan_override`` sub-doc), not a magic
 * status. See ``ScanOverride`` below for why.
 */
export type ScanStatus = "passed" | "flagged" | "unscanned";

/**
 * Audit record for an admin scan override.
 *
 * Set by ``POST /api/admin/skills/:source/:source_id/scan-override``
 * and persisted on the ``agent_skills`` (or ``hub_skills``) doc as a
 * separate field alongside the scanner-owned ``scan_status``. The
 * runtime gate (Python ``scan_gate.is_skill_blocked`` and Node
 * ``applyRunnableGate``) treats a flagged skill with this sub-doc
 * present as runnable iff ``ADMIN_SCAN_OVERRIDE_ENABLED`` is on;
 * otherwise it collapses back to blocked so a single env flip
 * removes the escape hatch in lockstep across both tiers.
 *
 * Why a separate field instead of ``scan_status: "admin_overridden"``:
 * the previous design encoded the override into the status string
 * itself, which collided with every scanner write path — any rescan
 * would blindly overwrite ``scan_status: "flagged"`` and silently
 * nuke the override. Splitting the signals lets scan routes write
 * status freely while the override stays stable until an admin
 * explicitly clears it.
 *
 * ``prior_scan_status`` is intentionally restricted to ``"flagged"``
 * because that is the only state from which an override can be
 * created — an admin can't pre-emptively override a passed or
 * unscanned skill (no reason to). Captured here so the UI can
 * render "Override active. Scanner had returned: flagged" without
 * keeping a stale copy of the original verdict somewhere else.
 */
export interface ScanOverride {
  /** Identity of the admin who set the override (email or user id). */
  set_by: string;
  /** ISO-8601 timestamp at which the override was set. */
  set_at: string;
  /** Free-form admin justification, persisted for audit. */
  reason: string;
  /** Scanner verdict at the moment of override (always ``"flagged"``). */
  prior_scan_status: "flagged";
  /** Snapshot of ``scan_summary`` at override time, if it existed. */
  prior_scan_summary?: string;
}

/**
 * @deprecated Kept as an alias for backwards source compatibility
 * during the migration away from the magic ``"admin_overridden"``
 * status. Now identical to ``ScanStatus`` — every callsite that
 * gated on ``scan_status === "admin_overridden"`` should be
 * rewritten to gate on ``!!scan_override`` instead. Will be removed
 * after the next release cuts.
 */
export type PersistedScanStatus = ScanStatus;

/**
 * Main agent skill interface
 * Represents both multi-task workflows and quick-start templates
 */
export interface AgentSkill {
  /** Unique identifier */
  id: string;
  /** Display name (e.g., "Create GitHub Repo") */
  name: string;
  /** Optional description of what this workflow does */
  description?: string;
  /** Category for organization */
  category: AgentSkillCategory | string;
  /** Ordered list of tasks to execute */
  tasks: AgentSkillTask[];
  /** Owner's email address (for user-created skills) */
  owner_id: string;
  /** Whether this is a system/built-in skill row in MongoDB (may be edited or removed; restore via import/seed) */
  is_system: boolean;
  /** Creation timestamp */
  created_at: Date;
  /** Last update timestamp */
  updated_at: Date;
  /** Additional metadata */
  metadata?: AgentSkillMetadata;
  
  // Quick-start template fields (for single-step workflows)
  /** Whether this is a quick-start template (single prompt, executes in chat) */
  is_quick_start?: boolean;
  /** Difficulty level for the workflow */
  difficulty?: WorkflowDifficulty;
  /** Icon name for display (e.g., "GitBranch", "Server", "Cloud") */
  thumbnail?: string;
  /** Custom input form for placeholder-based prompts */
  input_form?: WorkflowInputForm;
  /** Raw SKILL.md markdown content for skills built with the Skills Builder */
  skill_content?: string;
  /** Visibility level: private (owner only), team (shared teams), global (everyone) */
  visibility?: SkillVisibility;
  /**
   * Team slugs/refs shared via OpenFGA when `visibility` is `team`.
   * Populated on API read only — not stored in MongoDB.
   */
  shared_with_teams?: string[];
  /**
   * Persisted scan status: the scanner verdict, OR
   * ``"admin_overridden"`` if an admin has explicitly green-lit a
   * previously flagged skill via the per-skill override route.
   * (FR-027.) The override is read from ``scan_override`` below.
   */
  scan_status?: PersistedScanStatus;
  /** Optional scanner output / summary text persisted for UI report */
  scan_summary?: string;
  /** When the last scan result was persisted (save or manual Scan now) */
  scan_updated_at?: Date | string;
  /**
   * Audit metadata for an active admin override. Present iff
   * ``scan_status === "admin_overridden"``. Cleared (along with the
   * status flip back to "passed") when a rescan now returns
   * ``"passed"`` — at which point the override is no longer needed.
   */
  scan_override?: ScanOverride;
  /** Ancillary files (scripts, references, assets) keyed by relative path (FR-028) */
  ancillary_files?: Record<string, string>;
  /** Compact AI Review verdict from the last save. Drives the grade badge
   *  next to the scanner badge on skill cards. Optional — skills created
   *  before AI Review was wired up have this missing. */
  last_review?: import("./ai-review").LastReview;
}

/**
 * Input for creating a new agent skill
 */
export interface CreateAgentSkillInput {
  name: string;
  description?: string;
  category: AgentSkillCategory | string;
  tasks: AgentSkillTask[];
  metadata?: AgentSkillMetadata;
  // Quick-start fields
  is_quick_start?: boolean;
  difficulty?: WorkflowDifficulty;
  thumbnail?: string;
  input_form?: WorkflowInputForm;
  /** Raw SKILL.md markdown content */
  skill_content?: string;
  /** Visibility level: private (default), team, or global */
  visibility?: SkillVisibility;
  /** Teams to share with when visibility is `team` (written to OpenFGA only). */
  shared_with_teams?: string[];
  /** Scan status from skill-scanner on save (FR-027) */
  scan_status?: ScanStatus;
  /** Ancillary files keyed by relative path (FR-028) */
  ancillary_files?: Record<string, string>;
  /** AI Review verdict from save time. */
  last_review?: import("./ai-review").LastReview;
}

/**
 * Input for updating an existing agent skill
 */
export interface UpdateAgentSkillInput {
  name?: string;
  description?: string;
  category?: AgentSkillCategory | string;
  tasks?: AgentSkillTask[];
  metadata?: AgentSkillMetadata;
  // Quick-start fields
  is_quick_start?: boolean;
  difficulty?: WorkflowDifficulty;
  thumbnail?: string;
  input_form?: WorkflowInputForm;
  /** Raw SKILL.md markdown content */
  skill_content?: string;
  /** Visibility level: private, team, or global */
  visibility?: SkillVisibility;
  /** Teams to share with when visibility is `team` (written to OpenFGA only). */
  shared_with_teams?: string[];
  /** Scan status from skill-scanner on save (FR-027) */
  scan_status?: ScanStatus;
  /** Ancillary files keyed by relative path (FR-028) */
  ancillary_files?: Record<string, string>;
  /** AI Review verdict from save time. */
  last_review?: import("./ai-review").LastReview;
}

/**
 * Execution status for a task step
 */
export type TaskExecutionStatus = 
  | "pending"     // Not yet started
  | "in_progress" // Currently executing
  | "completed"   // Successfully finished
  | "failed"      // Execution failed
  | "skipped";    // Skipped due to condition

/**
 * Runtime state for a task during execution
 */
export interface TaskExecutionState {
  /** Task index in the workflow */
  taskIndex: number;
  /** Current status */
  status: TaskExecutionStatus;
  /** Start timestamp */
  startedAt?: Date;
  /** Completion timestamp */
  completedAt?: Date;
  /** Error message if failed */
  error?: string;
  /** Output/result from the task */
  output?: string;
}

/**
 * Runtime state for an entire workflow execution
 */
export interface WorkflowExecutionState {
  /** The config being executed */
  configId: string;
  /** Overall status */
  status: "idle" | "running" | "completed" | "failed" | "cancelled";
  /** Per-task execution states */
  taskStates: TaskExecutionState[];
  /** Collected form data from user inputs */
  formData: Record<string, unknown>;
  /** Start timestamp */
  startedAt?: Date;
  /** Completion timestamp */
  completedAt?: Date;
}

/**
 * Parsed variable from an LLM prompt template
 */
export interface PromptVariable {
  /** Variable name (e.g., "repo_name") */
  name: string;
  /** Whether this variable is required */
  required: boolean;
  /** Description extracted from prompt context */
  description?: string;
  /** Default value if specified */
  defaultValue?: string;
  /** Validation options (e.g., allowed values) */
  options?: string[];
}

/**
 * Helper function to extract variables from an LLM prompt
 * Supports formats:
 *   {variable_name}          — required, no default
 *   {{variable_name}}        — required, no default
 *   {{variable_name:default}} — optional, pre-filled with "default"
 */
export function extractPromptVariables(prompt: string): PromptVariable[] {
  const singleBracePattern = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
  // Capture inner content which may contain "name:default"
  const doubleBracePattern = /\{\{([^}]+)\}\}/g;
  
  const variables: PromptVariable[] = [];
  const seen = new Set<string>();
  
  let match;
  while ((match = singleBracePattern.exec(prompt)) !== null) {
    const name = match[1];
    if (!seen.has(name)) {
      seen.add(name);
      variables.push({ name, required: true });
    }
  }
  
  while ((match = doubleBracePattern.exec(prompt)) !== null) {
    const inner = match[1].trim();
    if (!inner) continue;

    const colonIdx = inner.indexOf(":");
    if (colonIdx !== -1) {
      const name = inner.substring(0, colonIdx).trim();
      const defaultValue = inner.substring(colonIdx + 1).trim();
      if (name && !seen.has(name)) {
        seen.add(name);
        variables.push({ name, required: false, defaultValue });
      }
    } else {
      const name = inner;
      if (!seen.has(name)) {
        seen.add(name);
        variables.push({ name, required: true });
      }
    }
  }
  
  return variables;
}

/**
 * Extract placeholders from a prompt and generate an input form
 */
export function generateInputFormFromPrompt(
  prompt: string,
  title: string
): WorkflowInputForm | null {
  const variables = extractPromptVariables(prompt);
  if (variables.length === 0) return null;
  
  const fields: WorkflowInputField[] = variables.map((variable) => {
    // Convert variable name to label
    let label = variable.name
      .replace(/_/g, " ")
      .replace(/-/g, " ")
      .replace(/([A-Z])/g, " $1")
      .replace(/\s+/g, " ")
      .trim();
    
    // Capitalize first letter of each word
    label = label
      .split(" ")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(" ");
    
    // Determine field type based on name
    let type: "text" | "url" | "number" = "text";
    const nameLower = variable.name.toLowerCase();
    if (nameLower.includes("url") || nameLower.includes("link")) {
      type = "url";
    } else if (nameLower.includes("count") || nameLower.includes("number")) {
      type = "number";
    }
    
    return {
      name: variable.name,
      label,
      placeholder: variable.defaultValue
        ? `Default: ${variable.defaultValue}`
        : `Enter ${label.toLowerCase()}`,
      type,
      required: variable.required,
      defaultValue: variable.defaultValue,
    };
  });
  
  return {
    title,
    description: `Please provide the following information`,
    fields,
    submitLabel: "Start",
  };
}

/**
 * Parse a task_config.yaml style object into AgentSkill array
 */
export function parseTaskConfigObject(
  config: Record<string, { tasks: Array<{ display_text: string; llm_prompt: string; subagent: string }> }>,
  ownerId: string = "system"
): AgentSkill[] {
  const now = new Date();
  
  return Object.entries(config).map(([name, value]) => {
    // Infer category from name
    let category: AgentSkillCategory = "Custom";
    if (name.toLowerCase().includes("github") || name.toLowerCase().includes("repo")) {
      category = "GitHub Operations";
    } else if (name.toLowerCase().includes("aws") || name.toLowerCase().includes("ec2") || name.toLowerCase().includes("eks") || name.toLowerCase().includes("s3")) {
      category = "AWS Operations";
    } else if (name.toLowerCase().includes("argocd") || name.toLowerCase().includes("deploy")) {
      category = "ArgoCD Operations";
    } else if (name.toLowerCase().includes("llm") || name.toLowerCase().includes("api key") || name.toLowerCase().includes("aigateway")) {
      category = "AI Gateway Operations";
    } else if (name.toLowerCase().includes("group") || name.toLowerCase().includes("user")) {
      category = "Group Management";
    }
    
    // Extract env vars from prompts
    const envVarPattern = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
    const envVars = new Set<string>();
    value.tasks.forEach(task => {
      let match;
      while ((match = envVarPattern.exec(task.llm_prompt)) !== null) {
        envVars.add(match[1]);
      }
    });
    
    return {
      id: `config-${name.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}`,
      name,
      description: `Workflow for: ${name}`,
      category,
      tasks: value.tasks.map(task => ({
        display_text: task.display_text,
        llm_prompt: task.llm_prompt,
        subagent: task.subagent as AgentSkillSubagent,
      })),
      owner_id: ownerId,
      is_system: ownerId === "system",
      created_at: now,
      updated_at: now,
      metadata: {
        env_vars_required: Array.from(envVars),
        schema_version: "1.0",
      },
    };
  });
}

/**
 * Built-in quick-start templates (formerly "Use Cases")
 *
 * @deprecated Templates are now loaded from disk at `charts/data/skills/`.
 * This array is kept for backward compatibility but is intentionally empty.
 * Use `loadSkillTemplatesInternal()` from `@/app/api/skills/skill-templates-loader`
 * and the seed route to populate MongoDB from disk templates instead.
 */
export const BUILTIN_QUICK_START_TEMPLATES: AgentSkill[] = [];

// ---------------------------------------------------------------------------
// Skill Metrics Types
// ---------------------------------------------------------------------------

export interface SkillRunStats {
  skill_id: string;
  skill_name: string;
  total_runs: number;
  completed: number;
  failed: number;
  success_rate: number;
  last_run: string | null;
  avg_duration_ms: number | null;
}

export interface SkillMetricsAdmin {
  total_skills: number;
  system_skills: number;
  user_skills: number;
  by_visibility: { private: number; team: number; global: number };
  by_category: Array<{ category: string; count: number }>;
  top_creators: Array<{ email: string; count: number }>;
  daily_created: Array<{ date: string; count: number }>;
  top_skills_by_runs: SkillRunStats[];
  overall_run_stats: {
    total_runs: number;
    completed: number;
    failed: number;
    success_rate: number;
    avg_duration_ms: number | null;
  };
}
