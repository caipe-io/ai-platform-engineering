import { loadConfiguredAgenticApps } from "@/lib/agentic-apps/config";
import { appForMcpResource } from "@/lib/agentic-apps/mcp-routing";
import { proxyAgenticAppRequest } from "@/lib/agentic-apps/proxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  try {
    const { path } = await context.params;
    const resource = `/${path.join("/")}`;
    const app = appForMcpResource(loadConfiguredAgenticApps(), resource);
    if (!app?.manifest.api.mcp) return new Response(null, { status: 404 });
    return proxyAgenticAppRequest(request, { params: Promise.resolve({
      appId: app.installation.appId, path: app.manifest.api.mcp.metadataPath.slice(1).split("/"),
    }), legacyMcpResource: resource === app.manifest.api.mcp.path });
  } catch { return Response.json({ error: "app_configuration_unavailable" }, { status: 503 }); }
}
