/**
 * POST /api/skills/token
 *
 * Generate a local skills API token (HS256 JWT) for programmatic access.
 * Requires an active NextAuth session. The generated token is scoped to
 * `skills:read` and always gets `role: 'user'` (no admin escalation).
 *
 * Request body (optional):
 *   { "expires_in_days": 30 | 60 | 90 }   (default 90, max 90)
 *
 * Response:
 *   { "token": "ey...", "token_type": "Bearer", "expires_in": 7776000, "scope": "skills:read" }
 */

import {
  getAuthenticatedUser,
  handleApiError,
  requireRbacPermission,
} from '@/lib/api-middleware';
import { signLocalSkillsToken } from '@/lib/jwt-validation';
import { NextRequest,NextResponse } from 'next/server';

const MAX_DAYS = 90;

export async function POST(request: NextRequest) {
  try {
    const { user, session } = await getAuthenticatedUser(request);
    await requireRbacPermission(session, 'skill', 'invoke');
    let days = MAX_DAYS;

    try {
      const body = await request.json();
      if (body.expires_in_days !== undefined) {
        const requested = Number(body.expires_in_days);
        if (!Number.isInteger(requested) || requested < 1 || requested > MAX_DAYS) {
          return NextResponse.json(
            { error: `expires_in_days must be an integer between 1 and ${MAX_DAYS}` },
            { status: 400 },
          );
        }
        days = requested;
      }
    } catch {
      // Empty body or invalid JSON — use defaults
    }

    const token = await signLocalSkillsToken(
      user.email,
      user.name,
      `${days}d`,
      session.sub ?? user.email,
    );
    const expiresIn = days * 86400;

    return NextResponse.json({
      token,
      token_type: 'Bearer',
      expires_in: expiresIn,
      scope: 'skills:read',
    });
  } catch (error) {
    return handleApiError(error);
  }
}
