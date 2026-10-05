/** Render gateway instructions from MongoDB, with file defaults for database-free development. */

import fs from "fs";
import { NextResponse } from "next/server";
import path from "path";
import { getCollection, isMongoDBConfigured } from "@/lib/mongodb";
import type { AgentSkill } from "@/types/agent-skill";
import {
AGENTS,
DEFAULT_AGENT_ID,
parseFrontmatter,
renderForAgent,
scopesAvailableFor,
type AgentScope,
type AgentSpec,
} from "../live-skills/agents";
import { getRequestOrigin } from "./request-origin";

/** Configuration for a skill-template route. Stable, intentionally small. */
export interface TemplateRouteConfig {
  /**
   * Stable identifier used in log prefixes (`[skills/<id>]`) and source
   * strings. Should match the route segment, e.g. `"live-skills"` or
   * `"update-skills"`.
   */
  routeId: string;

  /**
   * Env var holding inline template markdown. Highest-priority override.
   * E.g. `"SKILLS_LIVE_SKILLS_TEMPLATE"`.
   */
  envInlineKey: string;

  /**
   * Env var holding a filesystem path to the template. Tried after the
   * inline override. E.g. `"SKILLS_LIVE_SKILLS_FILE"`.
   */
  envFileKey: string;

  /**
   * Path (relative to repo root) to the chart-shipped template file.
   * E.g. `"charts/ai-platform-engineering/data/skills/live-skills.md"`.
   *
   * Resolved against the repo root for database-free development.
   */
  chartTemplatePath: string;

  /**
   * Used as last-resort fallback when no override and no chart file
   * exists. Should be a complete frontmatter+body markdown string.
   */
  fallbackTemplate: string;

  /** Default slash-command name. E.g. `"skills"` or `"update-skills"`. */
  defaultCommandName: string;

  /** Default frontmatter description. */
  defaultDescription: string;
}

/* --------------------------------------------------------------------------
 * Small utilities, factored out so each helper is independently testable.
 * Kept in this module (rather than a deeper utils file) because they are
 * route-input-shaped and don't make sense outside the template-route
 * context.
 * ------------------------------------------------------------------------ */

function safeReadFile(filePath: string, routeId: string): string | null {
  try {
    if (!filePath) return null;
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) return null;
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return null;
    // Cap at 256 KiB to prevent runaway reads / DoS.
    if (stat.size > 256 * 1024) {
      console.warn(
        `[skills/${routeId}] file too large (${stat.size} bytes): ${resolved}`,
      );
      return null;
    }
    return fs.readFileSync(resolved, "utf-8");
  } catch (err) {
    console.warn(`[skills/${routeId}] failed to read ${filePath}:`, err);
    return null;
  }
}

async function resolveTemplate(
  cfg: TemplateRouteConfig,
): Promise<{ template: string; source: string } | null> {
  if (isMongoDBConfigured) {
    const collection = await getCollection<AgentSkill & { skill_template?: string }>("agent_skills");
    const skill = await collection.findOne({
      is_system: true, visibility: "global",
      $or: [{ id: cfg.routeId }, { "metadata.template_source_id": cfg.routeId }],
    });
    const template = skill?.skill_content || skill?.skill_template || skill?.tasks?.[0]?.llm_prompt;
    return template
      ? { template, source: `mongodb:${cfg.routeId}` }
      : null;
  }
  const envInline = process.env[cfg.envInlineKey];
  if (envInline && envInline.trim().length > 0) {
    return { template: envInline, source: `env:${cfg.envInlineKey}` };
  }

  const envFile = process.env[cfg.envFileKey];
  if (envFile) {
    const fromFile = safeReadFile(envFile, cfg.routeId);
    if (fromFile) {
      return { template: fromFile, source: `file:${envFile}` };
    }
  }

  // Database-free development resolves packaged files from the repo root.
  const chartPath = path.resolve(
    process.cwd(),
    "..",
    cfg.chartTemplatePath,
  );
  const fromChart = safeReadFile(chartPath, cfg.routeId);
  if (fromChart) {
    return { template: fromChart, source: `file:${chartPath}` };
  }

  return { template: cfg.fallbackTemplate, source: "fallback" };
}

/**
 * Validate slash-command name. Allow letters, digits, hyphens, underscores,
 * dots; cap length. Anything else falls back to the default.
 */
function sanitizeCommandName(raw: string | null, fallback: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return fallback;
  if (trimmed.length > 64) return fallback;
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return fallback;
  return trimmed;
}

/** Cap description length to keep frontmatter sane. */
function sanitizeDescription(raw: string | null): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "";
  return trimmed.slice(0, 500);
}

/**
 * Validate base URL: only http(s), no embedded credentials, no path traversal.
 * Returns null if invalid.
 */
function sanitizeBaseUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function selectAgent(raw: string | null): {
  agent: AgentSpec;
  fallback: boolean;
} {
  const id = (raw ?? "").trim().toLowerCase();
  if (id && AGENTS[id]) return { agent: AGENTS[id], fallback: false };
  return { agent: AGENTS[DEFAULT_AGENT_ID], fallback: !!id };
}

function selectScope(raw: string | null): AgentScope | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "user" || v === "project") return v;
  return null;
}

/**
 * Build a Next.js `GET` route handler for a per-agent rendered template.
 *
 * @param cfg static configuration (template paths, defaults). Captured
 *            once at module load — must not depend on per-request state.
 */
export function makeTemplateRouteHandler(
  cfg: TemplateRouteConfig,
): (request: Request) => Promise<Response> {
  return async function GET(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { agent, fallback } = selectAgent(url.searchParams.get("agent"));
    const requestedScope = selectScope(url.searchParams.get("scope"));
    // `layout=` is intentionally accepted (and ignored) for backward
    // compatibility with copy-pasted one-liners from before the
    // skills-only overhaul. See spec FR-007.

    const commandName = sanitizeCommandName(
      url.searchParams.get("command_name"),
      cfg.defaultCommandName,
    );
    const descriptionInput = sanitizeDescription(
      url.searchParams.get("description"),
    );
    // `request.url` is the internal listen address behind an ingress;
    // the public origin lives on x-forwarded-* headers. Use the helper.
    const baseUrl =
      sanitizeBaseUrl(url.searchParams.get("base_url")) ??
      getRequestOrigin(request);

    let resolved: Awaited<ReturnType<typeof resolveTemplate>>;
    try {
      resolved = await resolveTemplate(cfg);
    } catch (error) {
      console.error(`[skills/${cfg.routeId}] Template lookup failed:`, error);
      return NextResponse.json({ error: "Skill database unavailable" }, { status: 503 });
    }
    if (!resolved) {
      return NextResponse.json({ error: `A global ${cfg.routeId} skill is required. Import its packaged template in the Skills UI, or apply the catalog migration for an existing install.` }, { status: 404 });
    }
    const { template: canonicalTemplate, source } = resolved;

    const parsedDescription = parseFrontmatter(canonicalTemplate).description.trim();
    const description =
      descriptionInput ||
      (/\{\{\w+\}\}/.test(parsedDescription) ? cfg.defaultDescription : "");

    const rendered = renderForAgent(agent, {
      canonicalTemplate,
      commandName,
      description,
      baseUrl,
      scope: requestedScope,
    });

    return NextResponse.json(
      {
        agent: agent.id,
        agent_fallback: fallback,
        label: rendered.label,
        template: rendered.template,
        install_path: rendered.install_path,
        install_paths: rendered.install_paths,
        scope: rendered.scope,
        scope_requested: requestedScope,
        scope_fallback: rendered.scope_fallback,
        scopes_available: rendered.scopes_available,
        launch_guide: rendered.launch_guide,
        docs_url: rendered.docs_url,

        agents: Object.values(AGENTS).map((a) => {
          const scopes = scopesAvailableFor(a);
          const installPaths: Partial<Record<AgentScope, readonly string[]>> = {};
          for (const s of scopes) {
            installPaths[s] = a.installPaths[s]!.map((p) =>
              p.replace(/\{name\}/g, commandName),
            );
          }
          return {
            id: a.id,
            label: a.label,
            install_paths: installPaths,
            scopes_available: scopes,
            arg_ref: a.argRef,
            docs_url: a.docsUrl,
          };
        }),

        source,
        inputs: {
          command_name: commandName,
          description: descriptionInput,
          base_url: baseUrl,
          scope: requestedScope,
        },
        canonical_template: canonicalTemplate,
        placeholders: [
          "{{COMMAND_NAME}}",
          "{{UPDATE_COMMAND_NAME}}",
          "{{DESCRIPTION}}",
          "{{BASE_URL}}",
          "{{ARG_REF}}",
        ],
        defaults: {
          command_name: cfg.defaultCommandName,
          description: cfg.defaultDescription,
        },
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  };
}
