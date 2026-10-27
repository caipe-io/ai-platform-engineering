// assisted-by claude code claude-sonnet-4-6
import { ApiError, requireRbacPermission, withErrorHandler } from "@/lib/api-middleware";
import { authOptions } from "@/lib/auth-config";
import { auditServiceUrl } from "@/lib/audit";
import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";

export const PUT = withErrorHandler(async (req: NextRequest) => {
  const session = (await getServerSession(authOptions)) as {
    accessToken?: string;
    sub?: string;
    org?: string;
    user?: { email?: string | null };
  } | null;
  if (!session?.user?.email) throw new ApiError("Unauthorized", 401);
  await requireRbacPermission(
    { accessToken: session.accessToken, sub: session.sub, org: session.org, user: { email: session.user.email ?? undefined } },
    "system_config",
    "configure",
  );

  const body = (await req.json().catch(() => null)) as { days?: unknown } | null;
  if (!body || typeof body.days !== "number") {
    return NextResponse.json({ error: 'body must be {"days": number}' }, { status: 400 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${auditServiceUrl()}/v1/audit/retention`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ days: body.days }),
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return NextResponse.json(
        { error: (data.detail as string) ?? `audit-service returned HTTP ${res.status}` },
        { status: res.status },
      );
    }
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 503 });
  } finally {
    clearTimeout(timeout);
  }
});
