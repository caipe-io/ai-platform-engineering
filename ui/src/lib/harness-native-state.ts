import { authorizeConversationReadAccess, authorizeConversationWriteAccess } from "@/app/api/v1/chat/_conversation-authz";
import type { AuthResult } from "@/lib/da-proxy";
import { getPinnedHarnessGatewayTarget, getHarnessGatewayNativeThread } from "@/lib/harness-gateway";
import { getHarnessEngineConfig, lookupHarnessSession } from "@/lib/harness-engine-proxy";
import { getCollection } from "@/lib/mongodb";
import { ApiError } from "@/lib/api-error";
import { requireWorkflowRunAccess, type WorkflowRunAccessDocument } from "@/lib/server/workflow-cas-authz";
import { NextResponse } from "next/server";

/** Translate only an owned Engine thread; preserve legacy workflow namespaces. */
export async function resolveHarnessNativeNamespace(raw: string, auth: AuthResult, write = false): Promise<string | NextResponse> {
  let namespace: unknown;
  try { namespace = JSON.parse(raw); } catch { return NextResponse.json({ error: "Invalid namespace" }, { status: 400 }); }
  if (!Array.isArray(namespace) || namespace.length !== 3 || namespace.some(part => typeof part !== "string")) {
    return NextResponse.json({ error: "Invalid namespace" }, { status: 400 });
  }
  if (namespace[2] !== "filesystem") return NextResponse.json({ error: "Only filesystem namespaces are public" }, { status: 403 });
  if (!auth.subject) return NextResponse.json({ error: "Caller identity required" }, { status: 401 });
  const workflow = await (await getCollection<WorkflowRunAccessDocument>("workflow_runs")).findOne({ _id: namespace[1] });
  if (workflow) {
    if (workflow.workflow_config_id !== namespace[0] || namespace[2] !== "filesystem") return NextResponse.json({ error: "Invalid workflow namespace" }, { status: 403 });
    try {
      await requireWorkflowRunAccess({ sub: auth.subject, isServiceAccount: auth.isServiceAccount }, workflow, write ? "write" : "read");
      return raw;
    } catch (error) {
      if (error instanceof ApiError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
      throw error;
    }
  }
  const authorized = await (write ? authorizeConversationWriteAccess : authorizeConversationReadAccess)(auth, namespace[1], namespace[0]);
  if (authorized.denial) return authorized.denial;
  const target = await getPinnedHarnessGatewayTarget(namespace[0], auth.subject, namespace[1]);
  if (target instanceof NextResponse) return target;
  const mapped = await getHarnessGatewayNativeThread(namespace[0], auth.subject, namespace[1]);
  if (target?.kind !== "harness_engine" && mapped === namespace[1]) return raw;
  if (target?.harnessId !== "dynamic_agents") return NextResponse.json({ error: "Files are unavailable for this harness" }, { status: 409 });
  if (target?.kind !== "harness_engine") return JSON.stringify([namespace[0], mapped, namespace[2]]);
  const config = getHarnessEngineConfig();
  if (config instanceof NextResponse) return config;
  const saved = await lookupHarnessSession(config, auth, namespace[0], namespace[1]);
  if (saved instanceof NextResponse) return saved;
  return JSON.stringify([namespace[0], saved.native_thread_id ?? namespace[1], namespace[2]]);
}
