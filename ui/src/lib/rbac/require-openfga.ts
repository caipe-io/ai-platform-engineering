import { ApiError } from "@/lib/api-error";
import { isDevAnonymousAuthEnabled } from "@/lib/auth/dev-auth-provider";
import {
adminSurfaceObject,
userProfileObject,
type AdminSurface,
type BaselineAdminSurface,
} from "@/lib/rbac/baseline-access";
import { checkOpenFgaTuple, listOpenFgaObjects } from "@/lib/rbac/openfga";

/**
 * Whether the caller administers at least one team (`team:<slug>#admin`).
 * Team admins get read-only visibility into any user's profile (edits stay
 * gated per-affected-team). Fail-soft: a transient PDP error returns false so
 * the stricter org-admin path still governs.
 */
async function actorAdministersAnyTeam(openfgaUser: string): Promise<boolean> {
  try {
    const result = await listOpenFgaObjects({
      user: openfgaUser,
      relation: "admin",
      type: "team",
    });
    return result.objects.length > 0;
  } catch {
    return false;
  }
}

export interface OpenFgaSessionSubject {
  sub?: string;
}

async function requireDerivedTuple(
  session: OpenFgaSessionSubject,
  relation: string,
  object: string,
  capability: string
): Promise<void> {
  if (isDevAnonymousAuthEnabled()) {
    return;
  }

  const subject = session.sub?.trim();
  if (!subject) {
    throw new ApiError("Your session has expired. Please sign in again.", 401, "NO_TOKEN", "session_expired", "sign_in");
  }

  try {
    const result = await checkOpenFgaTuple({
      user: `user:${subject}`,
      relation,
      object,
    });
    if (result.allowed) return;
  } catch {
    throw new ApiError(
      "Authorization service is temporarily unavailable. Please try again in a moment.",
      503,
      "PDP_UNAVAILABLE",
      "pdp_unavailable",
      "retry"
    );
  }

  throw new ApiError(
    "You do not have permission to view this read-only dashboard surface.",
    403,
    capability,
    "pdp_denied",
    "contact_admin"
  );
}

export function requireBaselineAdminSurfaceRead(
  session: OpenFgaSessionSubject,
  surface: BaselineAdminSurface
): Promise<void> {
  return requireDerivedTuple(
    session,
    "can_read",
    adminSurfaceObject(surface),
    `admin_surface:${surface}#can_read`
  );
}

export function requireAdminSurfaceManage(
  session: OpenFgaSessionSubject,
  surface: AdminSurface
): Promise<void> {
  return requireDerivedTuple(
    session,
    "can_manage",
    adminSurfaceObject(surface),
    `admin_surface:${surface}#can_manage`
  );
}

export async function requireUserProfileRead(
  session: OpenFgaSessionSubject,
  subject: string
): Promise<void> {
  if (isDevAnonymousAuthEnabled()) return;

  const caller = session.sub?.trim();
  if (!caller) {
    throw new ApiError("Your session has expired. Please sign in again.", 401, "NO_TOKEN", "session_expired", "sign_in");
  }

  return requireUserProfileReadAsActor(
    { openfgaUser: `user:${caller}`, selfSubjectId: caller },
    subject,
  );
}

export interface UserProfileReadActor {
  openfgaUser: string;
  /** Stable user subject for self-read semantics; omitted for team usersets. */
  selfSubjectId?: string;
  /** Team-admin usersets receive the same read-only profile access as a team admin. */
  administersAnyTeam?: boolean;
}

/** Apply the normal profile-read policy to an explicit OpenFGA actor. */
export async function requireUserProfileReadAsActor(
  actor: UserProfileReadActor,
  subject: string,
): Promise<void> {
  if (isDevAnonymousAuthEnabled()) return;

  const openfgaUser = actor.openfgaUser.trim();
  if (!openfgaUser) {
    throw new ApiError("A stable user subject is required.", 401, "NO_TOKEN", "session_expired", "sign_in");
  }

  // Fast path: a user can always read their own profile.
  if (actor.selfSubjectId === subject) {
    try {
      const result = await checkOpenFgaTuple({
        user: openfgaUser,
        relation: "can_read",
        object: userProfileObject(subject),
      });
      if (result.allowed) return;
    } catch {
      throw new ApiError(
        "Authorization service is temporarily unavailable. Please try again in a moment.",
        503,
        "PDP_UNAVAILABLE",
        "pdp_unavailable",
        "retry",
      );
    }

    throw new ApiError(
      "You do not have permission to view this read-only dashboard surface.",
      403,
      `user_profile:${subject}#can_read`,
      "pdp_denied",
      "contact_admin",
    );
  }

  // Reading ANOTHER user's profile is a privileged admin action. The
  // `user_profile` object is self-read only, so authorize via MANAGE on the
  // `users` admin surface — which org/super admins hold. We deliberately do
  // NOT accept baseline `can_read` on the surface here: a user with only
  // baseline read can see their own row in the list but must not open other
  // users' profiles.
  try {
    const result = await checkOpenFgaTuple({
      user: openfgaUser,
      relation: "can_manage",
      object: adminSurfaceObject("users"),
    });
    if (result.allowed) return;
  } catch {
    throw new ApiError(
      "Authorization service is temporarily unavailable. Please try again in a moment.",
      503,
      "PDP_UNAVAILABLE",
      "pdp_unavailable",
      "retry"
    );
  }

  // Team admins may VIEW any user's profile (read-only). Per-team edit
  // endpoints stay gated by `requireTeamMembershipManagementPermission`, so
  // this only widens read visibility, never write.
  if (actor.administersAnyTeam || await actorAdministersAnyTeam(openfgaUser)) return;

  throw new ApiError(
    "You do not have permission to view this user's profile.",
    403,
    `user_profile:${subject}#can_read`,
    "pdp_denied",
    "contact_admin"
  );
}
