// RFC 9728 OAuth 2.0 Protected Resource Metadata for the Platform MCP
// endpoint (`POST /api/mcp`). An MCP client that receives a 401 from that
// endpoint is pointed here (via `WWW-Authenticate: ... resource_metadata=`)
// to discover the authorization server, then follows RFC 8414 + RFC 7591
// (Dynamic Client Registration) to register itself and run PKCE — no
// per-deployment pre-registered client id required.

import { NextRequest, NextResponse } from "next/server";

import { isPlatformMcpEnabled } from "@/lib/mcp/guard";
import { publicMcpOrigin } from "@/lib/mcp/origin";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest) {
  // The public resource URL comes only from deployment configuration.
  void _request;
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

  let origin: string;
  try {
    origin = publicMcpOrigin();
  } catch (error) {
    console.error("Platform MCP origin configuration error:", error);
    return new NextResponse("Platform MCP is misconfigured", { status: 503 });
  }
  return NextResponse.json(
    {
      resource: `${origin}/api/mcp`,
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
