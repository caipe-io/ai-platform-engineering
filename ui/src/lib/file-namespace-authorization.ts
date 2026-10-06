import { NextRequest, NextResponse } from "next/server";

import { ApiError } from "@/lib/api-middleware";
import {
  authenticateRequest,
  type AuthResult,
} from "@/lib/da-proxy";
import { getCollection } from "@/lib/mongodb";
import { requireConversationResourcePermission } from "@/lib/rbac/conversation-implicit-authz";
import { requireAgentPermission } from "@/lib/rbac/resource-authz";
import type { WorkflowRunDocument } from "@/lib/server/workflow-engine";
import {
  requireWorkflowRunAccess,
  type WorkflowAuthzSession,
} from "@/lib/server/workflow-cas-authz";
import type { Conversation } from "@/types/mongodb";

export type FileNamespace = [string, string, "filesystem"];
export type FileNamespaceAction = "read" | "write";

export interface FileNamespaceAuthorization {
  authResult: AuthResult;
  namespace: FileNamespace;
}

export function parseFileNamespace(value: unknown): FileNamespace {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new ApiError("fs_namespace must be a valid JSON array", 400, "INVALID_NAMESPACE");
    }
  }

  if (
    !Array.isArray(parsed) ||
    parsed.length !== 3 ||
    !parsed.every((part) => typeof part === "string" && part.length > 0) ||
    parsed[2] !== "filesystem"
  ) {
    throw new ApiError(
      "fs_namespace must contain a resource ID, run ID, and filesystem marker",
      400,
      "INVALID_NAMESPACE",
    );
  }
  return parsed as FileNamespace;
}

export async function authorizeFileNamespace(
  request: NextRequest,
  rawNamespace: unknown,
  action: FileNamespaceAction,
): Promise<FileNamespaceAuthorization | NextResponse> {
  const namespace = parseFileNamespace(rawNamespace);
  const authResult = await authenticateRequest(request, {
    resource: "dynamic_agent",
    scope: "invoke",
  });
  if (authResult instanceof NextResponse) return authResult;
  if (!authResult.authzSession || !authResult.email) {
    throw new ApiError("Authenticated user context is required", 401, "NOT_SIGNED_IN");
  }

  const [resourceId, runId] = namespace;
  const conversations = await getCollection<Conversation>("conversations");
  const conversation = await conversations.findOne({ _id: runId });
  if (conversation) {
    const conversationAgentId = conversation.participants?.find(
      (participant) => participant.type === "agent",
    )?.id;
    if (!conversationAgentId || conversationAgentId !== resourceId) {
      throw new ApiError("File namespace does not match the conversation", 403, "NAMESPACE_FORBIDDEN");
    }
    await requireAgentPermission(authResult.authzSession, resourceId, "use");
    await requireConversationResourcePermission(
      authResult.authzSession,
      authResult.email,
      conversation,
      action,
    );
    return { namespace, authResult };
  }

  const workflowRuns = await getCollection<WorkflowRunDocument>("workflow_runs");
  const workflowRun = await workflowRuns.findOne({ _id: runId });
  if (!workflowRun || workflowRun.workflow_config_id !== resourceId) {
    throw new ApiError("File namespace was not found", 404, "NAMESPACE_NOT_FOUND");
  }
  await requireWorkflowRunAccess(
    authResult.authzSession as WorkflowAuthzSession,
    workflowRun,
    action,
  );
  return { namespace, authResult };
}
