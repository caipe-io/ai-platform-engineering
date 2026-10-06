/** Render code-owned gateway instructions from system_skills. */

import { NextResponse } from "next/server";
import { isMongoDBConfigured } from "@/lib/mongodb";
import { getSystemSkill, readPackagedSystemSkill, type SystemSkillId } from "@/lib/system-skills";
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
  routeId: SystemSkillId;

  /**
   * Used as last-resort fallback when no packaged file
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

async function resolveTemplate(
  cfg: TemplateRouteConfig,
): Promise<{ template: string; source: string } | null> {
  if (isMongoDBConfigured) {
    const skill = await getSystemSkill(cfg.routeId);
    return skill?.content
      ? { template: skill.content, source: `mongodb:system_skills/${cfg.routeId}` }
      : null;
  }
  try {
    return { template: readPackagedSystemSkill(cfg.routeId), source: `packaged:${cfg.routeId}` };
  } catch (error) {
    console.warn(`[skills/${cfg.routeId}] Packaged system skill unavailable:`, error);
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
