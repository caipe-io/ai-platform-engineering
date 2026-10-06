import { authOptions,isBootstrapAdmin } from "@/lib/auth-config";
import { getDevAnonymousSession,isDevAnonymousAuthEnabled } from "@/lib/auth/dev-auth-provider";
import { getCollection,isMongoDBConfigured } from "@/lib/mongodb";
import { checkOpenFgaTuple,readOpenFgaTuples } from "@/lib/rbac/openfga";
import { organizationObjectId } from "@/lib/rbac/organization";
import { isUserInTeam } from "@/lib/rbac/team-membership-store";
import { ObjectId } from "mongodb";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";

/**
 * GET /api/rbac/ingest-teams
 *
 * Returns the teams the caller may author NEW data sources for — i.e. the
 * "owning team" options for the Ingest form (spec 2026-06-03). A team is
 * eligible iff it holds the explicit org-level author capability
 * (`team:<slug>#member -> ingestor -> organization:<key>`) AND the caller is a
 * member of it.
 *
 * Org admins receive all teams (they may scope a new source to any team, or
 * create it personally with no owning team). Fails closed (empty list) on any
 * authorization backend error.
 *
 * assisted-by Cursor claude-opus-4.8
 */

interface OutTeam {
  _id: string;
  slug: string;
  name: string;
}

interface TeamDoc {
  _id: ObjectId;
  slug?: string;
  name?: string;
}

function getSessionSubject(session: { accessToken?: string; sub?: string }): string | undefined {
  if (session.sub) return session.sub;
  if (!session.accessToken) return undefined;
  try {
    const parts = session.accessToken.split(".");
    if (parts.length < 2) return undefined;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as
      | { sub?: unknown }
      | undefined;
    return typeof payload?.sub === "string" ? payload.sub : undefined;
  } catch {
    return undefined;
  }
}

async function isOrgAdmin(session: {
  sub?: string;
  accessToken?: string;
  user?: { email?: string | null };
}): Promise<boolean> {
  if (isDevAnonymousAuthEnabled()) return true;
  if (isBootstrapAdmin(session.user?.email ?? "")) return true;
  const subject = getSessionSubject(session);
  if (!subject) return false;
  try {
    const decision = await checkOpenFgaTuple({
      user: `user:${subject}`,
      relation: "can_manage",
      object: organizationObjectId(),
    });
    return decision.allowed;
  } catch {
    return false;
  }
}

/** Parse `team:<slug>#member` (or `#admin`) usersets into their team slugs. */
function teamSlugsFromIngestorTuples(
  tuples: { key: { user: string } }[],
): string[] {
  const slugs = new Set<string>();
  for (const t of tuples) {
    const match = /^team:([^#]+)#(?:member|admin)$/.exec(t.key.user);
    if (match) slugs.add(match[1]);
  }
  return [...slugs];
}

async function loadTeamsBySlug(slugs: string[]): Promise<Map<string, OutTeam>> {
  const out = new Map<string, OutTeam>();
  if (slugs.length === 0) return out;
  const teams = await getCollection("teams");
  const docs = (await teams.find({ slug: { $in: slugs } }).toArray()) as TeamDoc[];
  for (const doc of docs) {
    if (!doc.slug) continue;
    out.set(doc.slug, {
      _id: doc._id.toString(),
      slug: doc.slug,
      name: doc.name || doc.slug,
    });
  }
  return out;
}

export async function GET() {
  if (!isMongoDBConfigured) {
    return NextResponse.json({ teams: [] });
  }

  const session = ((await getServerSession(authOptions)) ?? (
    isDevAnonymousAuthEnabled() ? getDevAnonymousSession() : null
  )) as
    | {
        accessToken?: string;
        sub?: string;
        user?: { email?: string | null };
      }
    | null;

  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Org admins may author for any team.
  if (await isOrgAdmin(session)) {
    try {
      const teams = await getCollection("teams");
      const docs = (await teams.find({}).toArray()) as TeamDoc[];
      const all: OutTeam[] = docs
        .filter((d) => d.slug)
        .map((d) => ({
          _id: d._id.toString(),
          slug: d.slug as string,
          name: d.name || (d.slug as string),
        }));
      return NextResponse.json({ teams: all, org_admin: true });
    } catch {
      return NextResponse.json({ teams: [], org_admin: true });
    }
  }

  // Non-admins: teams that hold the capability AND that the user is a member of.
  let capabilitySlugs: string[];
  try {
    const result = await readOpenFgaTuples({
      tuple: { object: organizationObjectId(), relation: "ingestor" },
    });
    capabilitySlugs = teamSlugsFromIngestorTuples(result.tuples);
  } catch {
    return NextResponse.json({ teams: [], org_admin: false });
  }

  if (capabilitySlugs.length === 0) {
    return NextResponse.json({ teams: [], org_admin: false });
  }

  const subject = getSessionSubject(session);
  const email = session.user.email;
  const memberSlugs: string[] = [];
  for (const slug of capabilitySlugs) {
    try {
      if (await isUserInTeam(slug, { user_subject: subject, user_email: email })) {
        memberSlugs.push(slug);
      }
    } catch {
      // fail closed for this team
    }
  }

  const teamMap = await loadTeamsBySlug(memberSlugs);
  const teams = memberSlugs
    .map((slug) => teamMap.get(slug))
    .filter((t): t is OutTeam => Boolean(t));

  return NextResponse.json({ teams, org_admin: false });
}
