import { authOptions } from '@/lib/auth-config';
import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';

/**
 * User Info API Endpoint - Proxy to RAG Server
 *
 * This endpoint proxies to the RAG server's /v1/user/info endpoint.
 * The RAG server derives identity status from the JWT Bearer token when present.
 * 
 * Authentication:
 * - Authorization: Bearer {access_token} (OIDC JWT access token)
 * 
 * The RAG server does not support OAuth2Proxy headers.
 */

function getRagServerUrl(): string {
  return process.env.RAG_SERVER_URL ||
         process.env.NEXT_PUBLIC_RAG_URL ||
         'http://localhost:9446';
}

async function getRbacHeaders(): Promise<Record<string, string> | null> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  try {
    const session = await getServerSession(authOptions);

    console.log('[User Info] Session state:', {
      hasSession: !!session,
      hasUser: !!session?.user,
      userEmail: session?.user?.email,
      hasAccessToken: !!session?.accessToken,
      expiresAt: session?.expiresAt ? new Date((session.expiresAt as number) * 1000).toISOString() : 'N/A'
    });
    
    if (session?.accessToken) {
      headers['Authorization'] = `Bearer ${session.accessToken}`;
    } else {
      console.warn('[User Info] No accessToken in session; RAG user info requires authentication');
      return null;
    }

  } catch (error) {
    console.error('[User Info] Error retrieving session:', error);
  }

  return headers;
}

export async function GET() {
  const ragServerUrl = getRagServerUrl();
  const targetUrl = `${ragServerUrl}/v1/user/info`;
  const headers = await getRbacHeaders();
  if (!headers) {
    return NextResponse.json(
      { is_authenticated: false, email: 'unauthenticated', permissions: [] },
      { status: 401 },
    );
  }

  // Debug logging
  console.log('[User Info] Request headers:', {
    hasAuthorization: !!headers['Authorization']
  });

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers,
    });

    const data = await response.json();
    
    // Debug logging
    console.log('[User Info] RAG response:', {
      status: response.status,
      is_authenticated: data.is_authenticated,
      role: data.role,
      permissions: data.permissions,
      email: data.email
    });
    
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('[User Info] Error fetching from RAG server:', error);
    return NextResponse.json(
      { error: 'Failed to fetch user info from RAG server', details: String(error) },
      { status: 502 }
    );
  }
}
