import { getCollection } from "@/lib/mongodb";

const OPENFGA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~@|*+=,/-]{0,191}$/;

interface UserIdentityDocument {
  email?: string;
  name?: string;
  keycloak_sub?: string;
  metadata?: {
    keycloak_sub?: string;
  };
}

export interface ResolvedUserIdentity {
  subject: string;
  email: string | null;
  name: string | null;
  display_name: string;
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function subjectOf(user: UserIdentityDocument): string | null {
  return normalizeString(user.keycloak_sub) ?? normalizeString(user.metadata?.keycloak_sub);
}

function identityOf(user: UserIdentityDocument): ResolvedUserIdentity | null {
  const subject = subjectOf(user);
  if (!subject || !OPENFGA_ID_PATTERN.test(subject)) return null;
  const email = normalizeString(user.email);
  const name = normalizeString(user.name);
  return {
    subject,
    email,
    name,
    // Prefer a recognizable login for compact badges; the picker renders the
    // friendly name and email together when both are available.
    display_name: email ?? name ?? "Unknown user",
  };
}

function uniqueValidSubjects(subjects: readonly string[]): string[] {
  return Array.from(
    new Set(
      subjects
        .map((subject) => subject.trim())
        .filter((subject) => subject && OPENFGA_ID_PATTERN.test(subject)),
    ),
  );
}

/** Resolve persisted Keycloak subjects to names/emails without leaking IDs into UI copy. */
export async function resolveUserIdentitiesBySubject(
  subjects: readonly string[],
): Promise<Map<string, ResolvedUserIdentity>> {
  const wanted = uniqueValidSubjects(subjects);
  const resolved = new Map<string, ResolvedUserIdentity>();
  if (wanted.length === 0) return resolved;

  const users = await getCollection<UserIdentityDocument>("users");
  const rows = await users
    .find({
      $or: [
        { keycloak_sub: { $in: wanted } },
        { "metadata.keycloak_sub": { $in: wanted } },
      ],
    } as never)
    .project({ email: 1, name: 1, keycloak_sub: 1, "metadata.keycloak_sub": 1 })
    .toArray();
  for (const row of rows) {
    const identity = identityOf(row);
    if (identity) resolved.set(identity.subject, identity);
  }
  return resolved;
}

/** Resolve user-directory selections to immutable Keycloak subjects. */
export async function resolveUserIdentitiesByEmail(
  emails: readonly string[],
): Promise<Map<string, ResolvedUserIdentity>> {
  const wanted = Array.from(
    new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean)),
  );
  const resolved = new Map<string, ResolvedUserIdentity>();
  if (wanted.length === 0) return resolved;

  const users = await getCollection<UserIdentityDocument>("users");
  const rows = await users
    .find({ email: { $in: wanted } } as never)
    .project({ email: 1, name: 1, keycloak_sub: 1, "metadata.keycloak_sub": 1 })
    .toArray();
  for (const row of rows) {
    const identity = identityOf(row);
    if (identity?.email) resolved.set(identity.email.toLowerCase(), identity);
  }
  return resolved;
}

export function unresolvedUserIdentity(subject: string): ResolvedUserIdentity {
  return {
    subject,
    email: null,
    name: null,
    display_name: "Unknown user",
  };
}
