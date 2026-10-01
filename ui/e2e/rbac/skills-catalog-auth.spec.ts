/**
 * Regression: catalog credentials escaped their intended API boundary.
 *
 * Catalog API keys must be verified and bound to their real owner. Local
 * skills JWTs must preserve their constrained claims. Both credential types
 * may read `/api/skills` and must be rejected by unrelated APIs.
 *
 * These tests run against a live stack and require:
 *   RUN_RBAC_E2E=1            — standard RBAC e2e gate
 *   CAIPE_CATALOG_API_KEY     — catalog API key (same one caipe-skills.py uses)
 *   NEXTAUTH_SECRET           — to mint a test session cookie for the JWT test
 *
 * @see ui/src/app/api/skills/route.ts — filterSkillsByOpenFga
 * @see ui/src/lib/api-middleware.ts   — getAuthFromBearerOrSession
 */

import { test, expect } from "@playwright/test";
import { rbacEnvOrSkip } from "./_env";
import { installTestSession } from "./_helpers";

test.describe("Skills catalog API — auth subject regression", () => {
  // ---------------------------------------------------------------------------
  // Catalog API key path  (X-Caipe-Catalog-Key)
  // ---------------------------------------------------------------------------

  test("catalog API key returns non-zero skills including hub skills", async ({
    request,
  }) => {
    const env = rbacEnvOrSkip();

    const apiKey = process.env.CAIPE_CATALOG_API_KEY;
    test.skip(!apiKey, "CAIPE_CATALOG_API_KEY not set — skipping catalog key regression.");

    const resp = await request.get(`${env.baseUrl}/api/skills`, {
      headers: { "X-Caipe-Catalog-Key": apiKey! },
    });

    expect(resp.ok()).toBe(true);
    const body = (await resp.json()) as {
      skills: Array<{ id: string; source: string }>;
      meta: { total: number; sources_loaded: string[] };
    };

    // Before the fix this was always 0.
    expect(body.meta.total).toBeGreaterThan(0);

    // The key is bound to its real owner subject and uses normal OpenFGA reads.
    const sources = new Set(body.skills.map((s) => s.source));
    expect(sources.has("hub")).toBe(true);
    expect(sources.has("default")).toBe(true);
  });

  test("catalog API key is rejected outside the catalog read route", async ({
    request,
  }) => {
    const env = rbacEnvOrSkip();

    const apiKey = process.env.CAIPE_CATALOG_API_KEY;
    test.skip(!apiKey, "CAIPE_CATALOG_API_KEY not set — skipping catalog key regression.");

    const resp = await request.get(`${env.baseUrl}/api/mcp-servers`, {
      headers: { "X-Caipe-Catalog-Key": apiKey! },
    });

    expect(resp.status()).toBe(403);
  });

  // ---------------------------------------------------------------------------
  // Local skills JWT path  (Authorization: Bearer <HS256>)
  // ---------------------------------------------------------------------------

  test("local skills JWT returns non-zero skills", async ({ page }) => {
    const env = rbacEnvOrSkip();

    test.skip(
      !process.env.NEXTAUTH_SECRET,
      "NEXTAUTH_SECRET not set — cannot mint test session for /api/skills/token.",
    );

    // Mint a session cookie so /api/skills/token accepts the request.
    await installTestSession(page, env, {
      email: env.user.email,
      subject: env.user.sub ?? env.user.email,
      role: "admin",
    });

    // Exchange the session for a local skills JWT.
    const tokenResp = await page.request.post(`${env.baseUrl}/api/skills/token`);
    expect(tokenResp.ok()).toBe(true);
    const { token } = (await tokenResp.json()) as { token: string };
    expect(typeof token).toBe("string");

    // Call /api/skills with ONLY the Bearer token — no session cookie — so
    // the request goes through the local skills JWT path, not the NextAuth path.
    const skillsResp = await page.request.get(`${env.baseUrl}/api/skills`, {
      headers: { Authorization: `Bearer ${token}` },
      ignoreHTTPSErrors: true,
    });

    expect(skillsResp.ok()).toBe(true);
    const body = (await skillsResp.json()) as {
      skills: Array<{ id: string; source: string }>;
      meta: { total: number };
    };

    // Before the fix this was always 0 because session.sub was not set for
    // local skills JWTs, causing filterSkillsByOpenFga to return [].
    expect(body.meta.total).toBeGreaterThan(0);

    // Default skills pass through without OpenFGA for any authenticated user.
    const sources = new Set(body.skills.map((s) => s.source));
    expect(sources.has("default")).toBe(true);

    const blockedResp = await page.request.get(`${env.baseUrl}/api/mcp-servers`, {
      headers: { Authorization: `Bearer ${token}` },
      ignoreHTTPSErrors: true,
    });
    expect(blockedResp.status()).toBe(403);
  });

  test("invalid catalog API key returns 401 and cannot mint a token", async ({ request }) => {
    const env = rbacEnvOrSkip();
    const headers = { "X-Caipe-Catalog-Key": "sk_invalid.invalid-secret" };

    const skillsResp = await request.get(`${env.baseUrl}/api/skills`, { headers });
    expect(skillsResp.status()).toBe(401);

    const tokenResp = await request.post(`${env.baseUrl}/api/skills/token`, { headers });
    expect(tokenResp.status()).toBe(401);
  });

  // ---------------------------------------------------------------------------
  // Unauthenticated  (regression guard — must stay 401)
  // ---------------------------------------------------------------------------

  test("unauthenticated request returns 401", async ({ request }) => {
    const env = rbacEnvOrSkip();

    const resp = await request.get(`${env.baseUrl}/api/skills`);
    expect(resp.status()).toBe(401);
  });
});
