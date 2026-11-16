import { authenticateRequest } from "@/lib/da-proxy";
import { getHarnessEngineConfig, proxyHarnessEngine } from "@/lib/harness-engine-proxy";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const auth = await authenticateRequest(request);
    if (auth instanceof NextResponse) return auth;
    const config = getHarnessEngineConfig();
    if (config instanceof NextResponse) return config;
    return proxyHarnessEngine(config, auth, "/api/v1/agent-drafts/validate", {
      method: "POST",
      body: await request.text(),
    });
  } catch (error) {
    const candidate = error as { statusCode?: number; message?: string };
    return NextResponse.json(
      { success: false, error: candidate.message ?? "Authentication failed" },
      { status: candidate.statusCode ?? 401 },
    );
  }
}
