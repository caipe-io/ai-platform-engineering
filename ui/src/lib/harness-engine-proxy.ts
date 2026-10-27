import { NextResponse } from "next/server";

import type { AuthResult } from "@/lib/da-proxy";

export interface HarnessEngineConfig {
  url: string;
  internalToken: string;
}

export function isHarnessEngineConfigured(): boolean {
  return Boolean(
    process.env.HARNESS_ENGINE_URL?.trim() &&
      process.env.HARNESS_ENGINE_INTERNAL_TOKEN?.trim(),
  );
}

export function getHarnessEngineConfig(): HarnessEngineConfig | NextResponse {
  const url = process.env.HARNESS_ENGINE_URL?.trim().replace(/\/$/, "");
  const internalToken = process.env.HARNESS_ENGINE_INTERNAL_TOKEN?.trim();

  if (!url || !internalToken) {
    return NextResponse.json(
      { success: false, error: "Harness Engine is not configured" },
      { status: 503 },
    );
  }
  return { url, internalToken };
}

export function buildHarnessEngineHeaders(
  config: HarnessEngineConfig,
  auth: Pick<AuthResult, "subject" | "traceparent">,
  contentType = "application/json",
): Record<string, string> | NextResponse {
  if (!auth.subject) {
    return NextResponse.json(
      { success: false, error: "A stable caller subject is required" },
      { status: 401 },
    );
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${config.internalToken}`,
    "Content-Type": contentType,
    "X-Harness-Engine-Subject": auth.subject,
  };
  if (auth.traceparent) headers.traceparent = auth.traceparent;
  return headers;
}

export async function proxyHarnessEngine(
  config: HarnessEngineConfig,
  auth: Pick<AuthResult, "subject" | "traceparent">,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = buildHarnessEngineHeaders(config, auth);
  if (headers instanceof NextResponse) return headers;

  try {
    const response = await fetch(`${config.url}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers ?? {}) },
      cache: "no-store",
    });
    return new Response(response.body, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("Content-Type") ?? "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("[harness-engine] Backend request failed", error);
    return NextResponse.json(
      { success: false, error: "Harness Engine is unavailable" },
      { status: 503 },
    );
  }
}

export async function proxyHarnessEngineStream(
  config: HarnessEngineConfig,
  auth: Pick<AuthResult, "subject" | "traceparent">,
  path: string,
  signal?: AbortSignal,
): Promise<Response> {
  const headers = buildHarnessEngineHeaders(config, auth);
  if (headers instanceof NextResponse) return headers;
  headers.Accept = "text/event-stream";

  try {
    const response = await fetch(`${config.url}${path}`, {
      method: "GET",
      headers,
      cache: "no-store",
      signal,
    });
    if (!response.ok) {
      return new Response(response.body, {
        status: response.status,
        headers: { "Content-Type": response.headers.get("Content-Type") ?? "application/json" },
      });
    }
    return new Response(response.body, {
      status: response.status,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    if (signal?.aborted) {
      return new Response(null, { status: 499 });
    }
    console.error("[harness-engine] Event subscription failed", error);
    return NextResponse.json(
      { success: false, error: "Harness Engine is unavailable" },
      { status: 503 },
    );
  }
}

/** Read the Engine's owner-scoped binding without sharing its private database. */
export async function lookupHarnessSession(
  config: HarnessEngineConfig,
  auth: Pick<AuthResult, "subject" | "traceparent">,
  agentId: string,
  conversationId: string,
): Promise<{ harness_id: string | null } | NextResponse> {
  const response = await proxyHarnessEngine(config, auth, "/api/v1/sessions/lookup", {
    method: "POST",
    body: JSON.stringify({ agent_id: agentId, conversation_id: conversationId }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.success || !result.data ||
      !(result.data.harness_id === null || typeof result.data.harness_id === "string")) {
    return NextResponse.json({ success: false, error: "Harness session could not be resolved" }, { status: 503 });
  }
  return result.data;
}
