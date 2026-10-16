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
  /** Recipients dropped because no subject/email pair could be resolved. */
  skipped: number;
}

type UserLookup = Pick<User, "email" | "keycloak_sub"> & {
  metadata?: { keycloak_sub?: string };
};

function subjectOf(user: UserLookup): string | undefined {
  return user.keycloak_sub ?? user.metadata?.keycloak_sub;
}

/**
 * Turns producer-supplied references into complete {subject, email} pairs.
 * The inbox is keyed by subject and preferences by email, so both are needed.
 * Identifiers come from the trusted `users` collection, never from the request
 * alone, and anyone who cannot be resolved is skipped.
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
  const subjects = wanted.map((ref) => ref.subject).filter((v): v is string => Boolean(v));
  const emails = wanted.map((ref) => ref.email).filter((v): v is string => Boolean(v));

  const matches =
    subjects.length > 0 || emails.length > 0
      ? await users
          .find({
            $or: [
              ...(subjects.length > 0
                ? [{ keycloak_sub: { $in: subjects } }, { "metadata.keycloak_sub": { $in: subjects } }]
                : []),
              ...(emails.length > 0 ? [{ email: { $in: emails } }] : []),
            ],
          } as never)
          .toArray()
      : [];

  const bySubject = new Map<string, UserLookup>();
  const byEmail = new Map<string, UserLookup>();
  for (const user of matches) {
    const subject = subjectOf(user);
    if (subject) bySubject.set(subject, user);
    if (user.email) byEmail.set(user.email.toLowerCase(), user);
  }

  const resolved = new Map<string, ResolvedRecipient>();
  let skipped = 0;
  for (const ref of wanted) {
    const user =
      (ref.subject ? bySubject.get(ref.subject) : undefined) ??
      (ref.email ? byEmail.get(ref.email.toLowerCase()) : undefined);
    const subject = ref.subject ?? (user ? subjectOf(user) : undefined);
    const email = ref.email ?? user?.email;
    if (!subject || !email) {
      skipped += 1;
      continue;
    }
    if (!resolved.has(subject)) resolved.set(subject, { subject, email });
    if (resolved.size >= MAX_RESOLVED_RECIPIENTS) break;
  }

  return { recipients: [...resolved.values()], skipped };
}

/**
 * Direct `user:` admins of the organization. Admins who hold the role only
 * through a team are not expanded here, which keeps this bounded.
 */
export async function listOrgAdminSubjects(): Promise<string[]> {
  const subjects = new Set<string>();
  try {
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
  } catch (error) {
    console.error("[notifications] could not list organization admins", error);
  }
  return [...subjects];
}
