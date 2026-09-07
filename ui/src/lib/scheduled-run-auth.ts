/**
 * Scheduled-run owner authentication.
 *
 * A cron fire reaches the BFF as a thin, low-privilege call from the
 * caipe-cron-runner: it carries the shared ``X-Scheduler-Token`` to prove it
 * is the scheduler subsystem, but NO user identity the BFF is asked to trust.
 *
 * This module is the platform-side of the doc's flow (steps 3-5): given a
 * validated scheduler call, it
 *
 *   1. loads the immutable owner and agent from the schedule DB record (never
 *      from runner-supplied request fields),
 *   2. resolves that owner's Keycloak ``sub``,
 *   3. mints a real owner-user bearer via Keycloak token exchange
 *      (RFC 8693, ``requested_subject`` impersonation) using a dedicated,
 *      tightly-scoped ``caipe-scheduler-runner`` confidential client.
 *
 * The resulting bearer carries ``sub=<owner>`` and is forwarded to Dynamic
 * Agents so the run passes exactly the same DA/CAS/agent#use checks an
 * interactive owner run would, and fails closed at the same gates if the
 * owner has been disabled or lost access. No DA scheduled-run auth bypass.
 *
 * This mirrors the existing Python OBO impersonation flow used by service
 * integrations that invoke agents on behalf of a user.
 */

import { timingSafeEqual } from "crypto";

import { getCollection, isMongoDBConfigured } from "@/lib/mongodb";
import { findUserIdByEmail } from "@/lib/rbac/keycloak-admin";

const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

// Minted owner tokens are cached per owner sub until shortly before expiry so a
// burst of fires for one owner does not hammer Keycloak. Keyed by owner sub.
interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}
const ownerTokenCache = new Map<string, CachedToken>();
const EXPIRY_SAFETY_MS = 30_000;

function keycloakUrl(): string {
  const url = process.env.KEYCLOAK_URL?.trim();
  if (!url) throw new Error("KEYCLOAK_URL is not set");
  return url.replace(/\/$/, "");
}

function realm(): string {
  return process.env.KEYCLOAK_REALM?.trim() || "caipe";
}

function schedulerClientId(): string {
  return process.env.KEYCLOAK_SCHEDULER_CLIENT_ID?.trim() || "caipe-scheduler-runner";
}

function platformAudience(): string {
  return (
    process.env.CAIPE_PLATFORM_AUDIENCE?.trim() ||
    process.env.KEYCLOAK_SCHEDULER_AUDIENCE?.trim() ||
    "caipe-platform"
  );
}

function tokenEndpoint(): string {
  return `${keycloakUrl()}/realms/${encodeURIComponent(realm())}/protocol/openid-connect/token`;
}

/**
 * Constant-time check that a request's ``X-Scheduler-Token`` matches the
 * configured shared secret. Returns ``false`` (never throws) when the header is
 * absent or no secret is configured. The invoke route handles a presented but
 * invalid scheduler token as a failed scheduled request, never as interactive.
 */
export function isSchedulerTokenValid(token: string | null | undefined): boolean {
  if (!token) return false;
  const expected =
    process.env.SCHEDULER_SERVICE_TOKEN ||
    process.env.CAIPE_SCHEDULER_SERVICE_TOKEN ||
    "";
  if (!expected) return false;
  const actualBuffer = Buffer.from(token);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

/** Whether the scheduler shared secret is configured at all (deployment check). */
export function isSchedulerTokenConfigured(): boolean {
  return Boolean(
    process.env.SCHEDULER_SERVICE_TOKEN || process.env.CAIPE_SCHEDULER_SERVICE_TOKEN,
  );
}

interface ScheduleRunDoc {
  schedule_id: string;
  owner_sub?: string;
  owner_user_id?: string;
  agent_id?: string;
  project_id?: string | null;
  title?: string | null;
}

export interface ScheduledRunContext {
  /** Owner's Keycloak ``sub``: the impersonation target and authz subject. */
  sub: string;
  /** Owner's email (``owner_user_id``) for audit display + conversation owner. */
  email: string;
  /** Agent persisted on the schedule; runner-supplied agent IDs are ignored. */
  agentId: string;
  /** Persisted memory context; runner-supplied namespace values are ignored. */
  projectId: string | null;
  /** Human-readable schedule title persisted at creation time. */
  scheduleTitle: string | null;
}

/**
 * Resolve the authoritative owner and agent of a schedule from the DB record,
 * then map the owner to a Keycloak ``sub``.
 *
 * Run identity comes ONLY from the persisted schedule, never from
 * runner-supplied owner or agent fields. Returns ``null`` when the schedule or
 * the owner's Keycloak account cannot be found, so the caller fails closed.
 */
export async function resolveScheduledRunContext(
  scheduleId: string,
): Promise<ScheduledRunContext | null> {
  if (!scheduleId || !isMongoDBConfigured) return null;

  const schedules = await getCollection<ScheduleRunDoc>("schedules");
  const doc = await schedules.findOne({ schedule_id: scheduleId });
  if (!doc) {
    console.error(`[scheduled-run-auth] schedule not found: ${scheduleId}`);
    return null;
  }

  const email = (doc.owner_user_id || "").trim();
  const storedSub = (doc.owner_sub || "").trim();
  const agentId = (doc.agent_id || "").trim();

  if (!email || !agentId) {
    console.error(
      `[scheduled-run-auth] schedule ${scheduleId} has no owner_user_id or agent_id`,
    );
    return null;
  }

  // Resolve the existing owner; do NOT auto-provision. A scheduled run must
  // behave like the real owner, and a missing account means the owner was
  // never created or has been deprovisioned; fail closed.
  const sub = storedSub || await findUserIdByEmail(email);
  if (!sub) {
    console.error(
      `[scheduled-run-auth] no Keycloak user for schedule ${scheduleId} owner ${email}`,
    );
    return null;
  }
  return {
    sub,
    email,
    agentId,
    projectId: doc.project_id?.trim() || null,
    scheduleTitle: doc.title?.trim() || null,
  };
}

/**
 * Mint an owner-user access token via Keycloak token exchange
 * (``requested_subject`` impersonation) authenticating as the scoped
 * ``caipe-scheduler-runner`` client. Returns the access token string, or throws
 * on misconfiguration / Keycloak rejection so the caller fails the run closed.
 */
export async function mintScheduledOwnerToken(ownerSub: string): Promise<string> {
  if (!ownerSub) throw new Error("mintScheduledOwnerToken: ownerSub is required");

  const cached = ownerTokenCache.get(ownerSub);
  if (cached && cached.expiresAtMs > Date.now()) {
    return cached.accessToken;
  }

  const clientSecret = process.env.KEYCLOAK_SCHEDULER_CLIENT_SECRET?.trim();
  if (!clientSecret) {
    throw new Error(
      "KEYCLOAK_SCHEDULER_CLIENT_SECRET is not set; cannot mint scheduled-run owner token",
    );
  }

  const body = new URLSearchParams({
    grant_type: TOKEN_EXCHANGE_GRANT,
    client_id: schedulerClientId(),
    client_secret: clientSecret,
    requested_subject: ownerSub,
    requested_token_type: ACCESS_TOKEN_TYPE,
    audience: platformAudience(),
  });

  const response = await fetch(tokenEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `scheduled-run owner token exchange failed: ${response.status} ${detail.slice(0, 300)}`,
    );
  }

  const data = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!data.access_token) {
    throw new Error("scheduled-run owner token exchange returned no access_token");
  }

  const expiresInMs = (typeof data.expires_in === "number" ? data.expires_in : 300) * 1000;
  ownerTokenCache.set(ownerSub, {
    accessToken: data.access_token,
    expiresAtMs: Date.now() + Math.max(0, expiresInMs - EXPIRY_SAFETY_MS),
  });
  return data.access_token;
}

/** Test seam: clear the per-owner minted-token cache. */
export function _clearScheduledOwnerTokenCache(): void {
  ownerTokenCache.clear();
}
