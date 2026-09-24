// RFC 9728 OAuth 2.0 Protected Resource Metadata for the Platform MCP
// endpoint (`POST /api/mcp`). An MCP client that receives a 401 from that
// endpoint is pointed here (via `WWW-Authenticate: ... resource_metadata=`)
// to discover the authorization server, then follows RFC 8414 + RFC 7591
// (Dynamic Client Registration) to register itself and run PKCE — no
// per-deployment pre-registered client id required.

import { NextRequest, NextResponse } from "next/server";

import { isPlatformMcpEnabled } from "@/lib/mcp/guard";

export const dynamic = "force-dynamic";

function resourceOrigin(request: NextRequest): string {
  const configured = process.env.NEXTAUTH_URL;
  let origin: string;
  try {
    origin = configured ? new URL(configured).origin : new URL(request.url).origin;
  } catch {
    origin = new URL(request.url).origin;
  }
  const xfHost = request.headers.get("x-forwarded-host");
  if (!configured && xfHost) {
    origin = `${request.headers.get("x-forwarded-proto") || "https"}://${xfHost}`;
  }
  return origin;
}

export async function GET(request: NextRequest) {
  if (!isPlatformMcpEnabled()) {
    return new NextResponse("Not found", { status: 404 });
  }

  const issuer = (process.env.OIDC_ISSUER || "").replace(/\/+$/, "");
  if (!issuer) {
    // No OIDC issuer configured — nothing to discover. Still 404 rather than
    // a metadata document with an empty authorization_servers list, which
    // would leave a client stuck at the same dead end.
    return new NextResponse("Not found", { status: 404 });
  }

  const origin = resourceOrigin(request);
  return NextResponse.json(
    {
      resource: `${origin}/api/mcp`,
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
