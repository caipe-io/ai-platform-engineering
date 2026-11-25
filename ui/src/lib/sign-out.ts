"use client";

import { signOut } from 'next-auth/react';

function needsCsrfRetry(url?: string): boolean {
  if (!url) return false;
  const target = new URL(url, window.location.origin);
  return target.pathname === '/api/auth/signout' && target.searchParams.get('csrf') === 'true';
}

/** NextAuth's client does not check HTTP errors before following its redirect. */
export async function signOutWithFeedback(options: { callbackUrl?: string; redirect?: boolean } = {}): Promise<boolean> {
  try {
    const request = { ...options, redirect: false } as const;
    let result = await signOut(request);
    // Retry with a fresh CSRF token before leaving the current page so the
    // browser keeps the requested destination.
    if (needsCsrfRetry(result?.url)) result = await signOut(request);
    if ((result as { error?: string } | undefined)?.error || needsCsrfRetry(result?.url)) {
      throw new Error('Sign-out failed');
    }
    if (options.redirect !== false) window.location.assign(result?.url || options.callbackUrl || '/login');
    return true;
  } catch {
    window.alert('Sign out could not be completed. Please retry. Your session has not been cleared.');
    return false;
  }
}
