import { proxyAgenticAppRequest, type ProxyContext } from "@/lib/agentic-apps/proxy";

export async function GET(request: Request, context: ProxyContext): Promise<Response> {
  return proxyAgenticAppRequest(request, context);
}

export async function HEAD(request: Request, context: ProxyContext): Promise<Response> {
  return proxyAgenticAppRequest(request, context);
}

export async function POST(request: Request, context: ProxyContext): Promise<Response> {
  return proxyAgenticAppRequest(request, context);
}

export async function PUT(request: Request, context: ProxyContext): Promise<Response> {
  return proxyAgenticAppRequest(request, context);
}

export async function PATCH(request: Request, context: ProxyContext): Promise<Response> {
  return proxyAgenticAppRequest(request, context);
}

export async function DELETE(request: Request, context: ProxyContext): Promise<Response> {
  return proxyAgenticAppRequest(request, context);
}
