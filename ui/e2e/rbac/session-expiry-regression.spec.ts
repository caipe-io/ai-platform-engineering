import { expect, test } from '@playwright/test';
import { fulfillJson, installMockedRbacApp, mockedRbacEnabled, mockSessionBody } from './_mocked-rbac';

test('expired browser session shows the modal and countdown before redirecting to login', async ({ page }) => {
  test.skip(!mockedRbacEnabled() || !process.env.NEXTAUTH_SECRET, 'Requires mocked-browser session fixtures');
  test.setTimeout(130_000);
  const session = { email: 'user@example.test', name: 'Example User' };
  const expired = { ...mockSessionBody({ session }),
    expiresAt: Math.floor(Date.now() / 1000) - 60, hasRefreshToken: true };
  // Seed a valid server-side session; only the client response is expired.
  await installMockedRbacApp(page, { session, handlers: [async ({ path, route }) => {
    if (path === '/api/auth/session') {
      await fulfillJson(route, expired);
      return true;
    }
    if (path === '/api/auth/csrf' || path === '/api/auth/signout') {
      await route.continue();
      return true;
    }
    return false;
  }] });
  // Isolate the global expiry guard from the home page's separate AuthGuard.
  await page.goto('/settings', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Session Expired', { exact: true })).toBeVisible({ timeout: 110_000 });
  await expect(page.getByText(/redirecting to login in/i)).toBeVisible();
  await page.waitForURL(url => url.pathname === '/login' && url.searchParams.get('session_expired') === 'true',
    { timeout: 15_000 });
});
