import { getServerSession } from "next-auth";
import { notFound,redirect } from "next/navigation";

import { authOptions } from "@/lib/auth-config";
import { isUserConnectionsEnabled } from "@/lib/feature-flags/credentials";
import { checkOpenFgaTuple } from "@/lib/rbac/openfga";
import { organizationObjectId } from "@/lib/rbac/organization";

export default async function CredentialsLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.ReactElement> {
  if (!isUserConnectionsEnabled()) notFound();

  const session = await getServerSession(authOptions);
  if (!session?.user?.email) redirect("/login?callbackUrl=%2Fcredentials");

  const subject = typeof (session as { sub?: unknown }).sub === "string"
    ? (session as { sub: string }).sub.trim()
    : "";
  if (!subject) notFound();

  const access = await checkOpenFgaTuple({
    user: `user:${subject}`,
    relation: "can_use",
    object: organizationObjectId(),
  }).catch(() => ({ allowed: false }));
  if (!access.allowed) notFound();

  return <>{children}</>;
}
