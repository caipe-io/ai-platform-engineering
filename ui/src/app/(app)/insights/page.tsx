import { authOptions } from "@/lib/auth-config";
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";

// Personal insights are the admin statistics view scoped to a single user, so
// this path resolves the caller and hands off rather than duplicating the page.
export default async function InsightsPage(): Promise<never> {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email?.trim();
  redirect(
    email
      ? `/admin/insights/statistics?users=${encodeURIComponent(email)}`
      : "/admin/insights/statistics"
  );
}
