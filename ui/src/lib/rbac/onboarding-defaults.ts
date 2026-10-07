// assisted-by Cursor Claude:claude-opus-4-7
//
// Persistence for the "Onboarding Default Selection" cards on the Slack
// and Webex admin panels.
//
// Why this file exists
// --------------------
// The Slack/Webex defaults routes used to return env-only values
// (`SLACK_DEFAULT_TEAM_SLUG`, `SLACK_DEFAULT_AGENT_ID`). Picking a
// team/agent in the UI did nothing durable — the admin's choice lived
// in component state for the lifetime of the page and got lost on
// reload. The migration POST also did NOT save the choice; it ran the
// pipeline using whatever the request body contained.
//
// We need a small piece of org-wide persistence so admins can:
//   1. Pick a team + agent once and have those values come back on
//      refresh.
//   2. See clearly what's currently saved (we render it as a chip).
//   3. Save without running the migration pipeline.
//
// Storage
// -------
// We reuse the existing `platform_config` collection (single document
// keyed by `_id: "platform_settings"`) that already holds
// `default_agent_id`, `release_notes`, connector discovery cache TTLs,
// etc. Adding two more named sub-objects keeps everything in one place
// and avoids a new collection / migration.
//
// Document shape (additive):
//   {
//     _id: "platform_settings",
//     ...,
//     onboarding_defaults: {
//       slack:  { team_slug, agent_id, create_routes, updated_at, updated_by },
//       webex:  { team_slug, agent_id, create_routes, updated_at, updated_by },
//     }
//   }
//
// Resolution order on read
// ------------------------
//   1. DB value, if present and non-empty.
//   2. Slack-only env-var fallback for the legacy Slack bootstrap path.
//   3. Empty string (UI shows "not configured").

import type { Document } from "mongodb";

import { getCollection } from "@/lib/mongodb";

/**
 * Local re-throw type used by the validator. Routes catch this via
 * `instanceof OnboardingDefaultsValidationError` and translate it to
 * an `ApiError(400)` themselves — we keep the helper free of any
 * dependency on Next.js request/response types so the unit tests can
 * run in a plain node environment without polyfilling `Request`.
 */
export class OnboardingDefaultsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OnboardingDefaultsValidationError";
  }
}

export type OnboardingChannel = "slack" | "webex";

export interface OnboardingDefaults {
  team_slug: string;
  agent_id: string;
  create_routes: boolean;
  /** ISO timestamp from the DB. Empty when value came from env / unset. */
  updated_at: string;
  /** User email that performed the last save. Empty for env-only. */
  updated_by: string;
  /** Which layer supplied the result, useful for "Saved" vs "Env default" copy. */
  source: "db" | "env" | "unset";
}

interface PersistedOnboardingDefaultsDoc {
  team_slug?: unknown;
  agent_id?: unknown;
  create_routes?: unknown;
  updated_at?: unknown;
  updated_by?: unknown;
}

interface PlatformConfigDoc extends Document {
  _id: string;
  onboarding_defaults?: {
    slack?: PersistedOnboardingDefaultsDoc;
    webex?: PersistedOnboardingDefaultsDoc;
  };
}

const PLATFORM_CONFIG_ID = "platform_settings";

/**
 * Channel-specific env-var names. The Slack and Webex bots historically
 * picked these up at boot, so we keep them as a fallback for fresh
 * installs that haven't saved a DB value yet.
 */
const ENV_FALLBACKS: Partial<Record<OnboardingChannel, { team: string; agent: string }>> = {
  slack: { team: "SLACK_DEFAULT_TEAM_SLUG", agent: "SLACK_DEFAULT_AGENT_ID" },
};

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readDateString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
  }
  return "";
}

/**
 * Read the saved defaults for a given channel, falling back to env
 * vars when nothing is stored. Always returns a fully-populated object
 * (callers don't have to null-check).
 */
export async function readOnboardingDefaults(
  channel: OnboardingChannel,
): Promise<OnboardingDefaults> {
  const collection = await getCollection<PlatformConfigDoc>("platform_config");
  const doc = await collection.findOne({ _id: PLATFORM_CONFIG_ID } as never);
  const saved = doc?.onboarding_defaults?.[channel];

  const dbTeam = readString(saved?.team_slug);
  const dbAgent = readString(saved?.agent_id);
  const updatedAt = readDateString(saved?.updated_at);
  const updatedBy = readString(saved?.updated_by);
  const dbCreateRoutes =
    typeof saved?.create_routes === "boolean" ? saved.create_routes : null;

  // Treat a DB row as "real" if the admin saved at least one of the
  // two ids, OR if the row carries a timestamp (which only PUT writes).
  // Otherwise fall through to env vars so legacy bootstrap still works.
  const hasDbValue = Boolean(dbTeam || dbAgent || updatedAt);

  if (hasDbValue) {
    return {
      team_slug: dbTeam,
      agent_id: dbAgent,
      create_routes: dbCreateRoutes ?? true,
      updated_at: updatedAt,
      updated_by: updatedBy,
      source: "db",
    };
  }

  const envFallback = ENV_FALLBACKS[channel];
  const envTeam = envFallback ? readString(process.env[envFallback.team]) : "";
  const envAgent = envFallback ? readString(process.env[envFallback.agent]) : "";
  if (envFallback && (envTeam || envAgent)) {
    return {
      team_slug: envTeam,
      agent_id: envAgent,
      create_routes: true,
      updated_at: "",
      updated_by: "",
      source: "env",
    };
  }

  return {
    team_slug: "",
    agent_id: "",
    create_routes: true,
    updated_at: "",
    updated_by: "",
    source: "unset",
  };
}

export interface WriteOnboardingDefaultsInput {
  team_slug: string;
  agent_id: string;
  create_routes: boolean;
  actor: string;
}

/**
 * Persist saved defaults. Empty strings are allowed and clear that
 * particular field (so an admin can un-pin a deleted team / agent).
 *
 * The shape is strictly validated so a malformed PUT can't poison the
 * shared `platform_config` doc.
 */
export async function writeOnboardingDefaults(
  channel: OnboardingChannel,
  input: WriteOnboardingDefaultsInput,
): Promise<OnboardingDefaults> {
  const teamSlug = readString(input.team_slug);
  const agentId = readString(input.agent_id);
  const createRoutes = Boolean(input.create_routes);
  const actor = readString(input.actor) || "api";

  // A 360-line typo on the panel shouldn't blow up the schema — but a
  // truly absurd payload should. 256 is generous for both slugs and
  // OpenFGA agent ids.
  if (teamSlug.length > 256 || agentId.length > 256) {
    throw new OnboardingDefaultsValidationError(
      "team_slug and agent_id must each be 256 characters or shorter",
    );
  }

  const now = new Date();
  const collection = await getCollection<PlatformConfigDoc>("platform_config");
  await collection.updateOne(
    { _id: PLATFORM_CONFIG_ID } as never,
    {
      $set: {
        [`onboarding_defaults.${channel}`]: {
          team_slug: teamSlug,
          agent_id: agentId,
          create_routes: createRoutes,
          updated_at: now,
          updated_by: actor,
        },
        updated_at: now,
        updated_by: actor,
      },
    },
    { upsert: true },
  );

  return {
    team_slug: teamSlug,
    agent_id: agentId,
    create_routes: createRoutes,
    updated_at: now.toISOString(),
    updated_by: actor,
    source: "db",
  };
}
