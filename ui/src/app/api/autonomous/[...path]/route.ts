// Copyright CAIPE Contributors (https://caipe.io)
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';

import {
  withAuth,
  withErrorHandler,
  ApiError,
  resolveKeycloakSubFromSession,
} from '@/lib/api-middleware';
import { getConfig } from '@/lib/config';
import { checkOpenFgaTuple } from '@/lib/rbac/openfga';
import { organizationObjectId } from '@/lib/rbac/organization';
import { subjectFromSession } from '@/lib/rbac/resource-authz';

/**
 * Autonomous Agents API Proxy.
 *
 * Forwards every method (GET/POST/PUT/PATCH/DELETE) under
 * `/api/autonomous/<...path>` to the autonomous-agents FastAPI
 * service at `AUTONOMOUS_AGENTS_URL` (default `http://localhost:8002`).
 *
 * Why a proxy instead of calling the FastAPI service directly from the
 * browser:
 *   1. The autonomous-agents service binds to 8002 and isn't exposed
 *      publicly in any deployment topology -- the UI is the only
 *      sanctioned entry point.
 *   2. Auth lives at the Next.js boundary. We require a NextAuth
 *      session here and forward caller identity downstream via the
 *      `X-Authenticated-User-*` headers so the backend can apply
 *      per-task ownership rules without re-implementing OIDC.
 *   3. Centralising the URL keeps the React side decoupled -- code
 *      always hits `/api/autonomous/...` regardless of where the
 *      backend physically runs.
 *
 * Authorization model:
 *   - The caller must belong to at least one Autonomous-enabled team (or be an
 *     organization admin). The backend then applies per-task ownership using
 *     the headers injected below.
 *   - Team entitlement and per-agent access are enforced by Dynamic Agents on
 *     every unattended run through CAS/OpenFGA.
 *   - Admin detection here resolves through `getAuthenticatedUser`,
 *     which reads the post-promotion session role. NextAuth's jwt /
 *     session callbacks promote Mongo-flagged or OIDC-group admins
 *     into `session.role === 'admin'` before any API route runs, so
 *     this proxy does not perform a separate MongoDB lookup. The
 *     `useAdminRole` hook and `requireConversationAccess` resolve the
 *     same way (OIDC group first, MongoDB `users.metadata.role`
 *     fallback), keeping the three admin surfaces in lock-step.
 */

/**
 * Base URL for the autonomous-agents service, **without** the API
 * version prefix. Operators set this to e.g.
 * ``http://localhost:8002`` or ``http://autonomous-agents:8002``;
 * the ``/api/v1`` segment is added by ``buildTargetUrl`` below so a
 * prefix bump (v2 etc.) only touches one constant.
 */
function getAutonomousAgentsUrl(): string {
  return (
    process.env.AUTONOMOUS_AGENTS_URL ||
    process.env.NEXT_PUBLIC_AUTONOMOUS_AGENTS_URL ||
    'http://localhost:8002'
  );
}

/**
 * FastAPI mounts both the tasks and webhooks routers under
 * ``/api/v1`` (see ``autonomous_agents/main.py``). We hard-code the
 * prefix here rather than baking it into the env var so:
 *   1. operators can copy/paste the same URL they'd use for a
 *      ``curl localhost:8002/healthz`` smoke test, AND
 *   2. an upstream version bump (v1 -> v2) is a one-line edit.
 */
const AUTONOMOUS_API_PREFIX = '/api/v1';

function buildTargetUrl(request: NextRequest, pathSegments: string[]): URL {
  const targetPath = pathSegments.join('/');
  // Strip a trailing slash on the env var so we don't end up with
  // ``//api/v1/tasks`` (some HTTP stacks tolerate it, others don't).
  const base = getAutonomousAgentsUrl().replace(/\/$/, '');
  const targetUrl = new URL(`${base}${AUTONOMOUS_API_PREFIX}/${targetPath}`);
  // Forward query parameters (the run-history endpoints don't take any
  // today, but future pagination params would otherwise be silently
  // dropped here).
  request.nextUrl.searchParams.forEach((value, key) => {
    targetUrl.searchParams.append(key, value);
  });
  return targetUrl;
}

async function readBody(request: NextRequest): Promise<unknown> {
  const contentLength = request.headers.get('content-length');
  if (!contentLength || parseInt(contentLength, 10) === 0) {
    return undefined;
  }
  try {
    return await request.json();
  } catch {
    // Some endpoints (manual trigger) accept an empty body; others
    // would reject malformed JSON downstream. Either way, surfacing
    // ``undefined`` here is correct -- we only forward a body if we
    // managed to parse one.
    return undefined;
  }
}

type SupportedMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function forward(
  request: NextRequest,
  pathSegments: string[],
  method: SupportedMethod,
): Promise<NextResponse> {
  if (!getConfig('autonomousAgentsEnabled')) {
    throw new ApiError('Autonomous agents are disabled', 404);
  }

  return await withAuth(request, async (_req, user, session) => {
    const openFgaUser = subjectFromSession(session);
    if (!openFgaUser) {
      throw new ApiError('Autonomous access requires a resolvable user identity', 403);
    }
    const entitlement = await checkOpenFgaTuple({
      user: openFgaUser,
      relation: 'can_automate',
      object: organizationObjectId(),
    });
    if (!entitlement.allowed) {
      throw new ApiError('Your team is not enabled for Autonomous', 403);
    }

    // Entitled callers reach the per-user backend, which enforces task ownership.
    const targetUrl = buildTargetUrl(request, pathSegments);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // Inject caller identity so the autonomous-agents service can stamp
      // owner_id on task creation and filter the task list per-user.
      // The proxy has already enforced the NextAuth session above — the
      // FastAPI service trusts these headers because it is not publicly
      // reachable (internal service, no direct browser access).
      'X-Authenticated-User-Email': user.email,
      'X-Authenticated-User-Is-Admin': String(session.role === 'admin'),
    };

    // Also forward the caller's Keycloak subject (UUID). OpenFGA/CAS key
    // subjects by `sub`, not email, so the autonomous-agents service needs it
    // to stamp owner_sub on the task — that is what the dynamic-agents runtime
    // authorizes against when it later runs the task unattended on the owner's
    // behalf. Omitted when the session carries no resolvable sub (the backend
    // then treats the task as not authorizable per-owner).
    const callerSub = resolveKeycloakSubFromSession(session);
    if (callerSub) {
      headers['X-Authenticated-User-Sub'] = callerSub;
    }

    const fetchOptions: RequestInit = { method, headers };
    if (method !== 'GET' && method !== 'DELETE') {
      const body = await readBody(request);
      if (body !== undefined) {
        fetchOptions.body = JSON.stringify(body);
      }
    }

    try {
      const response = await fetch(targetUrl.toString(), fetchOptions);

      // 204 No Content -- pass through verbatim so the UI sees a clean
      // success without a body parse attempt.
      if (response.status === 204) {
        return new NextResponse(null, { status: 204 });
      }

      // The autonomous-agents service always replies in JSON, but read
      // as text first so we can surface a useful error envelope even if
      // the upstream returned a non-JSON body (e.g. on a crash).
      const text = await response.text();
      if (!text) {
        return new NextResponse(null, { status: response.status });
      }
      try {
        const data = JSON.parse(text);
        return NextResponse.json(data, { status: response.status });
      } catch {
        console.error(
          `[Autonomous Proxy] ${method} ${targetUrl} returned non-JSON ` +
            `(HTTP ${response.status}): ${text.slice(0, 500)}`,
        );
        return NextResponse.json(
          {
            detail:
              `Autonomous Agents service returned an invalid response ` +
              `(HTTP ${response.status}). Check the service logs.`,
          },
          { status: response.status },
        );
      }
    } catch (error) {
      console.error(`[Autonomous Proxy] ${method} ${targetUrl} failed:`, error);
      // Map upstream connectivity failures to ``ApiError`` so they
      // flow through the shared ``withErrorHandler`` envelope and we
      // don't leak ``error.toString()`` shapes that vary by Node
      // version.
      throw new ApiError(
        `Failed to reach autonomous-agents service: ${
          error instanceof Error ? error.message : String(error)
        }`,
        502,
      );
    }
  });
}

export const GET = withErrorHandler(async (
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) => {
  const { path } = await context.params;
  return forward(request, path, 'GET');
});

export const POST = withErrorHandler(async (
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) => {
  const { path } = await context.params;
  return forward(request, path, 'POST');
});

export const PUT = withErrorHandler(async (
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) => {
  const { path } = await context.params;
  return forward(request, path, 'PUT');
});

export const PATCH = withErrorHandler(async (
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) => {
  const { path } = await context.params;
  return forward(request, path, 'PATCH');
});

export const DELETE = withErrorHandler(async (
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) => {
  const { path } = await context.params;
  return forward(request, path, 'DELETE');
});
