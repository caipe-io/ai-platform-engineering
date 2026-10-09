import { ApiError, getAuthFromBearerOrSession, handleApiError, requireRbacPermission } from '@/lib/api-middleware';
import { isDevAnonymousAuthEnabled } from '@/lib/auth/dev-auth-provider';
import { NextRequest, NextResponse } from 'next/server';

/**
 * RAG Evaluator API Proxy with OIDC Authentication
 *
 * Proxies requests from /api/rag-evaluator/* to the caipe-rag-evaluator service.
 *
 * Pattern & Architecture:
 * - Unauthenticated health probe bypass for /api/rag-evaluator/health (readiness probe)
 * - Authenticated proxy for evaluation jobs, question-sets, and results
 * - Forwards Bearer token and tenant/RBAC headers upstream
 */

function getEvaluatorServiceUrl(): string {
  return process.env.EVALUATOR_SERVICE_URL ||
         process.env.NEXT_PUBLIC_EVALUATOR_URL ||
         'http://localhost:8000';
}

async function handleProxy(
  request: NextRequest,
  context: { params: Promise<{ path?: string[] }> },
): Promise<NextResponse> {
  try {
    const { path: rawPathSegments } = await context.params;
    const pathSegments = rawPathSegments ?? [];
    const targetPath = pathSegments.join('/');
    const method = request.method.toUpperCase();

    // 1. Unauthenticated health / docs probe bypass (matching /api/rag/healthz)
    const lowerPath = targetPath.toLowerCase();
    if (['health', 'docs', 'openapi.json', 'redoc'].includes(lowerPath)) {
      const upstreamUrl = `${getEvaluatorServiceUrl()}/${targetPath}`;
      const res = await fetch(upstreamUrl, { method: 'GET' });
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = await res.json().catch(() => ({}));
        if (lowerPath === 'openapi.json' && data && typeof data === 'object') {
          data.servers = [{ url: '/api/rag-evaluator' }];
        }
        return NextResponse.json(data, { status: res.status });
      }
      let text = await res.text();
      if (lowerPath === 'docs') {
        text = text.replaceAll("url: '/openapi.json'", "url: '/api/rag-evaluator/openapi.json'");
      }
      return new NextResponse(text, {
        status: res.status,
        headers: { 'Content-Type': contentType || 'text/html; charset=utf-8' },
      });
    }

    // 2. Resolve authentication from Bearer JWT or NextAuth session
    const { session } = await getAuthFromBearerOrSession(request);

    if (!session?.user?.email) {
      throw new ApiError('Unauthorized', 401);
    }

    if (!session.accessToken && !isDevAnonymousAuthEnabled()) {
      throw new ApiError('A Keycloak access token is required for Evaluator access.', 401, 'NOT_SIGNED_IN');
    }

    // Coarse RBAC permission check
    const scope = method === 'GET' ? 'query' : 'admin';
    await requireRbacPermission(
      { accessToken: session.accessToken, sub: session.sub, org: session.org, user: session.user },
      'rag',
      scope,
    );

    // 3. Build upstream headers and URL
    const headers: Record<string, string> = {
      'Content-Type': request.headers.get('content-type') || 'application/json',
    };

    if (session?.accessToken) {
      headers['Authorization'] = `Bearer ${session.accessToken}`;
    }
    if (session?.org) {
      headers['X-Tenant-Id'] = session.org;
    }

    const upstreamUrl = new URL(`${getEvaluatorServiceUrl()}/${targetPath}`);
    request.nextUrl.searchParams.forEach((val, key) => {
      upstreamUrl.searchParams.append(key, val);
    });

    let body: string | undefined;
    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      body = await request.text();
    }

    // 5. Execute upstream fetch
    const response = await fetch(upstreamUrl.toString(), {
      method,
      headers,
      body: body || undefined,
    });

    if (response.status === 204) {
      return new NextResponse(null, { status: 204 });
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await response.json().catch(() => ({}));
      return NextResponse.json(data, { status: response.status });
    }

    const text = await response.text();
    return new NextResponse(text, {
      status: response.status,
      headers: { 'Content-Type': contentType || 'text/plain' },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path?: string[] }> },
): Promise<NextResponse> {
  return handleProxy(request, context);
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ path?: string[] }> },
): Promise<NextResponse> {
  return handleProxy(request, context);
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ path?: string[] }> },
): Promise<NextResponse> {
  return handleProxy(request, context);
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ path?: string[] }> },
): Promise<NextResponse> {
  return handleProxy(request, context);
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ path?: string[] }> },
): Promise<NextResponse> {
  return handleProxy(request, context);
}
