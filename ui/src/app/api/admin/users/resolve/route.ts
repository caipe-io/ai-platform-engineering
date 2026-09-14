// GET /api/admin/users/resolve
//
// Exact, first-party user-directory lookup used by bots (the Slack bot, and
// any future bot) that hold only a service-account token and must resolve a
// Keycloak user without holding realm-management credentials of their own.
// Replaces the Slack bot's former direct Keycloak Admin reads (`get_user_by_*`,
// `get_user_attribute`). Slack provisioning uses this BFF boundary so bots do
// not hold Keycloak Admin credentials.
//
// Pick exactly ONE locator:
//   ?attribute=<name>&value=<v>  → exact attribute match (whitelisted names)
//   ?email=<addr>                → exact email match
//   ?id=<sub>                    → fetch by Keycloak id (the JWT `sub`)
//
// Returns `{ success, data: { sub, enabled, attributes } | null }`. A miss is
// `data: null` with HTTP 200 (NOT 404) so the Python callers treat
// "not found" as a normal branch.

import { NextRequest } from "next/server";

import {
  ApiError,
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import {
  findRealmUserIdByAttribute,
  findUserIdByEmail,
  getRealmUserByIdOrNull,
  getUserFederatedIdentities,
} from "@/lib/rbac/keycloak-admin";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";

// Gate on the user-directory admin surface. The OpenFGA `admin_surface` type
// lists `service_account` as a valid `reader`, so the bot's client-credentials
// caller (graphed as `service_account:<sub>`) can be granted
// `reader admin_surface:user_directory` by the realm init seed. This surface is
// distinct from #1781's `user_provisioning` so lookup access is grantable
// separately from create access (least privilege). Org admins pass via bypass.
const USER_DIRECTORY_SURFACE_ID = "user_directory";

// SECURITY: a bot SA must not be able to resolve a user by an arbitrary
// attribute — that is a broader directory-scraping surface than provisioning.
// Restrict `?attribute=` to the exact names the Slack bot reads.
const ALLOWED_ATTRIBUTE_NAMES = new Set([
  "slack_user_id",
  "slack_preauth_prompted",
  "slack_preauth_prompted_at",
  "caipe_default_team_id",
]);

// Conservative upper bound; a Keycloak email/attribute value is realistically
// far shorter. Guards against absurd query strings before we touch Keycloak.
const MAX_VALUE_LENGTH = 320;

function requireString(value: string | null, label: string): string {
  if (value === null) {
    throw new ApiError(`${label} is required`, 400, "INVALID_QUERY");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ApiError(`${label} must not be empty`, 400, "INVALID_QUERY");
  }
  if (trimmed.length > MAX_VALUE_LENGTH) {
    throw new ApiError(`${label} is too long`, 400, "INVALID_QUERY");
  }
  return trimmed;
}

function normalizeAttributes(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(v)) out[k] = v.map(String);
    else if (v != null) out[k] = [String(v)];
  }
  return out;
}

// Shape the Keycloak UserRepresentation down to the contract the bot needs:
// the `sub` (id), whether the account is `enabled` (the bot drops disabled
// users), and the `attributes` bag (the bot reads specific values off it).
function toResolvedUser(
  user: Record<string, unknown>,
  federatedIdentities: unknown[] = []
): {
  sub: string;
  enabled: boolean;
  attributes: Record<string, string[]>;
  federatedIdentities: unknown[];
} {
  return {
    sub: String(user.id ?? ""),
    enabled: user.enabled !== false,
    attributes: normalizeAttributes(user.attributes),
    federatedIdentities,
  };
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);

  // First-party admin surface: the bot service account is granted
  // `reader admin_surface:user_directory`; org admins pass via the bypass.
  await requireResourcePermission(
    session,
    { type: "admin_surface", id: USER_DIRECTORY_SURFACE_ID, action: "read" },
    { bypassForOrgAdmin: true }
  );

  const { searchParams } = new URL(request.url);
  const attribute = searchParams.get("attribute");
  const value = searchParams.get("value");
  const email = searchParams.get("email");
  const id = searchParams.get("id");

  // Exactly one locator. Count which were provided so we can reject ambiguous
  // or empty queries with a clear 400.
  const locators = [attribute !== null, email !== null, id !== null].filter(
    Boolean
  ).length;
  if (locators === 0) {
    throw new ApiError(
      "One locator is required: ?attribute=&value=, ?email=, or ?id=",
      400,
      "INVALID_QUERY"
    );
  }
  if (locators > 1) {
    throw new ApiError(
      "Provide exactly one locator (attribute, email, or id)",
      400,
      "INVALID_QUERY"
    );
  }

  let user: Record<string, unknown> | null = null;

  if (attribute !== null) {
    const attrName = requireString(attribute, "attribute");
    if (!ALLOWED_ATTRIBUTE_NAMES.has(attrName)) {
      throw new ApiError(
        `attribute "${attrName}" is not allowed`,
        400,
        "ATTRIBUTE_NOT_ALLOWED"
      );
    }
    const attrValue = requireString(value, "value");
    const foundId = await findRealmUserIdByAttribute(attrName, attrValue);
    if (foundId) {
      user = await getRealmUserByIdOrNull(foundId);
    }
  } else if (email !== null) {
    const emailValue = requireString(email, "email");
    const foundId = await findUserIdByEmail(emailValue);
    if (foundId) {
      user = await getRealmUserByIdOrNull(foundId);
    }
  } else {
    // id locator
    const userId = requireString(id, "id");
    user = await getRealmUserByIdOrNull(userId);
  }

  const federatedIdentities = user
    ? await getUserFederatedIdentities(String(user.id ?? ""))
    : [];

  return successResponse(user ? toResolvedUser(user, federatedIdentities) : null);
});
