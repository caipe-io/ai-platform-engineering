"use client";

import { signOut } from 'next-auth/react';

/** NextAuth's client does not check HTTP errors before following its redirect. */
export async function signOutWithFeedback(options: { callbackUrl?: string; redirect?: boolean } = {}): Promise<boolean> {
  try {
    const result = await signOut({ ...options, redirect: false });
    if ((result as { error?: string } | undefined)?.error) throw new Error('Revocation failed');
    if (options.redirect !== false) window.location.assign(result?.url || options.callbackUrl || '/login');
    return true;
  } catch {
    window.alert('Sign out could not be completed. Please retry. Your session has not been cleared.');
    return false;
  }
}
