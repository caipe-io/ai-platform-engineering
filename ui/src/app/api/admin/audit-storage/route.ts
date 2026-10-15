// assisted-by claude code claude-sonnet-4-6
import { ApiError, requireRbacPermission, withErrorHandler } from "@/lib/api-middleware";
import { authOptions } from "@/lib/auth-config";
import { auditServiceUrl } from "@/lib/audit";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";

async function proxyGet<T>(path: string): Promise<{ data: T | null; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(`${auditServiceUrl()}${path}`, { cache: "no-store", signal: controller.signal });
    if (!res.ok) {
      return { data: null, error: `audit-service returned HTTP ${res.status}` };
    }
    return { data: (await res.json()) as T };
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

export interface AuditStorageResponse {
  storage: Record<string, unknown> | null;
  retention: Record<string, unknown> | null;
  verbosity: Record<string, unknown> | null;
  errors: string[];
}

export const GET = withErrorHandler(async () => {
  const session = (await getServerSession(authOptions)) as {
    accessToken?: string;
    sub?: string;
    org?: string;
    user?: { email?: string | null };
  } | null;
  if (!session?.user?.email) throw new ApiError("Unauthorized", 401);
  await requireRbacPermission(
    { accessToken: session.accessToken, sub: session.sub, org: session.org, user: { email: session.user.email ?? undefined } },
    "admin_ui",
    "audit.view",
  );

  const [storageResult, retentionResult, verbosityResult] = await Promise.all([
    proxyGet<Record<string, unknown>>("/v1/audit/storage"),
    proxyGet<Record<string, unknown>>("/v1/audit/retention"),
    proxyGet<Record<string, unknown>>("/v1/audit/verbosity"),
  ]);

  const errors: string[] = [];
  if (storageResult.error) errors.push(`storage: ${storageResult.error}`);
  if (retentionResult.error) errors.push(`retention: ${retentionResult.error}`);
  if (verbosityResult.error) errors.push(`verbosity: ${verbosityResult.error}`);

  return NextResponse.json({
    storage: storageResult.data,
    retention: retentionResult.data,
    verbosity: verbosityResult.data,
    errors,
  } satisfies AuditStorageResponse);
});
