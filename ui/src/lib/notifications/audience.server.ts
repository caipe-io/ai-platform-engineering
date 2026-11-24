import { getCollection } from "@/lib/mongodb";
import { readOpenFgaTuples } from "@/lib/rbac/openfga";
import { organizationObjectId } from "@/lib/rbac/organization";
import type { RecipientRef } from "@/lib/notifications/request";
import type { User } from "@/types/mongodb";

/** Hard cap on one fan-out, so a bad producer cannot flood the inbox. */
export const MAX_RESOLVED_RECIPIENTS = 200;

export interface ResolvedRecipient {
  subject: string;
  email: string;
}

export interface ResolvedAudience {
  recipients: ResolvedRecipient[];
  /** Recipients dropped because no user record matched them. */
  skipped: number;
  /** Recipients rejected because their identifiers disagree or are ambiguous. */
  rejected: number;
}

type UserLookup = Pick<User, "email" | "keycloak_sub"> & {
  metadata?: { keycloak_sub?: string };
};

function subjectOf(user: UserLookup): string | undefined {
  return user.keycloak_sub ?? user.metadata?.keycloak_sub;
}

function sameUser(a: UserLookup, b: UserLookup): boolean {
  return (
    subjectOf(a) === subjectOf(b) &&
    a.email.toLowerCase() === b.email.toLowerCase()
  );
}

function exactEmailPattern(email: string): RegExp {
  return new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
}

/**
 * Turns producer-supplied references into complete {subject, email} pairs.
 * The inbox is keyed by subject and preferences by email, so both must name
 * the same person. Every recipient must match a record in the trusted `users`
 * collection, and both identifiers are taken from that record, never from the
 * request. If a request supplies both identifiers and they do not resolve to
 * the same user, the recipient is rejected.
 */
export async function resolveRecipients(
  refs: RecipientRef[],
  options: { includeOrgAdmins: boolean },
): Promise<ResolvedAudience> {
  const wanted: RecipientRef[] = [...refs];
  if (options.includeOrgAdmins) {
    const adminSubjects = await listOrgAdminSubjects();
    for (const subject of adminSubjects) wanted.push({ subject });
  }

  const users = await getCollection<UserLookup>("users");
  const subjects = new Set(
    wanted.map((ref) => ref.subject).filter((v): v is string => Boolean(v)),
  );
  const emails = new Set(
    wanted.map((ref) => ref.email).filter((v): v is string => Boolean(v)),
  );
  const emailMatches = emails.size
    ? await users.find({ email: { $in: [...emails].map(exactEmailPattern) } }).toArray()
    : [];

  const byEmail = new Map<string, UserLookup | null>();
  for (const user of emailMatches) {
    const subject = subjectOf(user);
    if (subject) subjects.add(subject);
    if (user.email) {
      const email = user.email.toLowerCase();
      const previous = byEmail.get(email);
      // Older records may differ only by casing. Never choose the recipient
      // or preference record based on the database's iteration order.
      const ambiguous = previous === null ||
        (previous !== undefined && (!sameUser(previous, user) || previous.email !== user.email));
      byEmail.set(email, ambiguous ? null : user);
    }
  }

  // An email lookup can miss another record with the same subject. Verify
  // every candidate subject in a single query before accepting any match.
  const subjectIds = [...subjects];
  const subjectMatches = subjectIds.length
    ? await users.find({
        $or: [
          { keycloak_sub: { $in: subjectIds } },
          { "metadata.keycloak_sub": { $in: subjectIds } },
        ],
      }).toArray()
    : [];
  const bySubject = new Map<string, UserLookup | null>();
  for (const user of subjectMatches) {
    const subject = subjectOf(user);
    if (subject) bySubject.set(subject, bySubject.has(subject) ? null : user);
  }

  const resolved = new Map<string, ResolvedRecipient>();
  let skipped = 0;
  let rejected = 0;
  for (const ref of wanted) {
    const byEmailMatch = ref.email
      ? byEmail.get(ref.email.toLowerCase())
      : undefined;
    const subject = ref.subject || (byEmailMatch ? subjectOf(byEmailMatch) : undefined);
    const bySubjectMatch = subject ? bySubject.get(subject) : undefined;

    if (bySubjectMatch === null || byEmailMatch === null) {
      rejected += 1;
      continue;
    }
    if (bySubjectMatch && byEmailMatch && !sameUser(bySubjectMatch, byEmailMatch)) {
      console.warn("[notifications] rejected recipient: subject and email no longer match");
      rejected += 1;
      continue;
    }
    if (ref.subject && ref.email && (!bySubjectMatch || !byEmailMatch)) {
      if (bySubjectMatch || byEmailMatch) rejected += 1;
      else skipped += 1;
      continue;
    }

    const email = bySubjectMatch?.email;
    if (!subject || !email) {
      skipped += 1;
      continue;
    }
    if (!resolved.has(subject)) resolved.set(subject, { subject, email });
    if (resolved.size >= MAX_RESOLVED_RECIPIENTS) break;
  }

  return { recipients: [...resolved.values()], skipped, rejected };
}

/**
 * Direct `user:` admins of the organization. Admins who hold the role only
 * through a team are not expanded here, which keeps this bounded.
 */
export async function listOrgAdminSubjects(): Promise<string[]> {
  const subjects = new Set<string>();
  let continuationToken: string | undefined;
  do {
    const page = await readOpenFgaTuples({
      tuple: { relation: "admin", object: organizationObjectId() },
      pageSize: 100,
      continuationToken,
    });
    for (const tuple of page.tuples) {
      const match = /^user:(.+)$/.exec(tuple.key.user);
      if (match?.[1]) subjects.add(match[1]);
    }
    continuationToken = page.continuationToken;
  } while (continuationToken && subjects.size < MAX_RESOLVED_RECIPIENTS);
  return [...subjects];
}
