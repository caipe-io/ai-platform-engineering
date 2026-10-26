import { authOptions } from "@/lib/auth-config";
import NextAuth from "next-auth";
import { NextRequest, NextResponse } from "next/server";

const handler = NextAuth(authOptions);

export { handler as GET };

export async function POST(request: NextRequest, context: { params: Promise<{ nextauth: string[] }> }) {
  let signOutFailed = false;
  const response = await NextAuth({
    ...authOptions,
    events: {
      ...authOptions.events,
      async signOut(event) {
        try { await authOptions.events?.signOut?.(event); }
        catch { signOutFailed = true; }
      },
    },
  })(request, context);
  // NextAuth swallows event errors and clears cookies. Do not claim logout
  // succeeded when durable revocation failed; retain the cookie so it can retry.
  // The event only runs after NextAuth's normal CSRF validation.
  if (signOutFailed) return NextResponse.json({
    error: 'Sign out could not be completed. Please retry.', code: 'SESSION_UNAVAILABLE',
    reason: 'session_unavailable', action: 'retry',
  }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  return response;
}
