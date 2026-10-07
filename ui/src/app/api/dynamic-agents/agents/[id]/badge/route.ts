import {
  authenticateRequest,
  getDynamicAgentsConfig,
  proxyRequest,
} from "@/lib/da-proxy";
import { getCollection } from "@/lib/mongodb";
import { NextRequest, NextResponse } from "next/server";

/** Explicit admin publication. Mongo stores receipts; Identity Node stores badges. */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (process.env.AGNTCY_IDENTITY_ENABLED !== "true") {
    return NextResponse.json({ error: "Agent Badge publication is disabled" }, { status: 404 });
  }
  const auth = await authenticateRequest(request, { resource: "admin_ui", scope: "admin" });
  if (auth instanceof NextResponse) return auth;
  // DA uses the same platform-admin flag. Org-level grants cannot publish here.
  if (auth.role !== "admin") {
    return NextResponse.json({ error: "Admin role required" }, { status: 403 });
  }
  const config = getDynamicAgentsConfig();
  if (config instanceof NextResponse) return config;
  const { id } = await context.params;
  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > 512 * 1024) {
    return NextResponse.json({ error: "Public definition exceeds the size limit" }, { status: 413 });
  }
  const response = await proxyRequest(
    new URL(`/api/v1/agents/${encodeURIComponent(id)}/badge`, config.dynamicAgentsUrl).toString(),
    "POST", auth, "[agent-badge]", body,
  );
  if (response.ok) {
    const receipt = await response.clone().json();
    // Do not persist the supplied definition, bearer token, or signing material.
    try {
      const collection = await getCollection("agent_identity_badges");
      await collection.updateOne(
        { _id: receipt.credential_id },
        { $set: { ...receipt, published_by: auth.subject, published_at: new Date() } },
        { upsert: true },
      );
    } catch {
      // Publication has completed remotely. Preserve its receipt for recovery.
      return NextResponse.json({ ...receipt, receipt_persisted: false }, { status: 200 });
    }
  }
  return response;
}
