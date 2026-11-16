import { loadConfiguredAgenticApps } from "@/lib/agentic-apps/config";
import { appForMcpResource, externalMcpRoute } from "@/lib/agentic-apps/mcp-routing";
import { proxyAgenticAppRequest } from "@/lib/agentic-apps/proxy";

export const dynamic = "force-dynamic";

/** Keep saved MCP URLs working when an app moves behind the hosted gateway. */
async function proxyRootMcp(request: Request, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await context.params;
  const pathname = `/api/${path.join("/")}`;
  const resource = pathname.endsWith("/openapi.json")
    ? pathname.slice(0, -"/openapi.json".length) : pathname;
  let app: ReturnType<typeof appForMcpResource>;
  try {
    const apps = loadConfiguredAgenticApps();
    app = appForMcpResource(apps, pathname)
      ?? (resource !== pathname ? appForMcpResource(apps, resource) : null);
  }
  catch { return Response.json({ error: "app_configuration_unavailable" }, { status: 503 }); }
  if (!app || !externalMcpRoute(app.manifest, request.method, pathname)) {
    return new Response(null, { status: 404 });
  }
  return proxyAgenticAppRequest(request, {
    params: Promise.resolve({ appId: app.installation.appId, path: ["api", ...path] }),
    legacyMcpResource: true,
  });
}

export { proxyRootMcp as GET, proxyRootMcp as HEAD, proxyRootMcp as POST, proxyRootMcp as DELETE };
