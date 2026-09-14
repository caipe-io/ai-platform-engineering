// PATCH /api/admin/users/[id]/attributes
//
// First-party attribute-merge endpoint used by bots that hold only a
// service-account token. Replaces the Slack bot's former direct Keycloak
// Admin attribute write (`set_user_attribute`). Slack provisioning uses this
// BFF boundary so bots do not hold Keycloak Admin credentials.
//
// Body: `{ attributes: Record<string, string[]> }`. Merge semantics (existing
// attributes preserved) are delegated to the lib `mergeUserAttributes`, which
// already does the Keycloak-26 user-profile round-trip the Python
// `set_user_attribute` replicated.
//
// Response: `{ success, data: { ok: true } }`.

import { NextRequest } from "next/server";

import {
  ApiError,
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { mergeUserAttributes } from "@/lib/rbac/keycloak-admin";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";

// Gate on the user-directory admin surface (write). The OpenFGA `admin_surface`
// type lists `service_account` as a valid `writer`, so the bot SA can be
// granted `writer admin_surface:user_directory` by the realm init seed. Org
// admins pass via the bypass.
const USER_DIRECTORY_SURFACE_ID = "user_directory";

// SECURITY: a bot SA must not be able to set arbitrary identity attributes.
// Restrict writable keys to the exact ones the Slack bot writes. Anything else
// (including the server-owned `created_by` / `created_at` provenance fields,
// consistent with provision-shell) is rejected with 400.
const ALLOWED_ATTRIBUTE_KEYS = new Set([
  "slack_user_id",
  "slack_preauth_prompted_at",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAttributes(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) {
    throw new ApiError(
      "attributes is required and must be an object of string arrays",
      400,
      "INVALID_ATTRIBUTES"
    );
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    throw new ApiError("attributes must not be empty", 400, "INVALID_ATTRIBUTES");
  }
  const out: Record<string, string[]> = {};
  for (const [key, raw] of entries) {
    if (!ALLOWED_ATTRIBUTE_KEYS.has(key)) {
      throw new ApiError(
        `attribute "${key}" is not allowed`,
        400,
        "ATTRIBUTE_NOT_ALLOWED"
      );
    }
    if (!Array.isArray(raw) || !raw.every((v) => typeof v === "string")) {
      throw new ApiError(
        `attribute "${key}" must be an array of strings`,
        400,
        "INVALID_ATTRIBUTES"
      );
    }
    out[key] = raw;
  }
  return out;
}

export const PATCH = withErrorHandler(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session } = await getAuthFromBearerOrSession(request);

    await requireResourcePermission(
      session,
      { type: "admin_surface", id: USER_DIRECTORY_SURFACE_ID, action: "write" },
      { bypassForOrgAdmin: true }
    );

    const { id } = await context.params;
    const userId = id?.trim();
    if (!userId) {
      throw new ApiError("user id is required", 400, "INVALID_USER_ID");
    }

    const rawBody = await request.json().catch(() => null);
    if (!isRecord(rawBody)) {
      throw new ApiError("Request body must be a JSON object", 400, "INVALID_BODY");
    }

    const attributes = parseAttributes(rawBody.attributes);
    await mergeUserAttributes(userId, attributes);

    return successResponse({ ok: true });
  }
);
