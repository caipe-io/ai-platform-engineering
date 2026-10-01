// assisted-by Codex Codex-sonnet-4-6

import { expect, test, type Route } from "@playwright/test";

import { rbacEnvOrSkip } from "./_env";
import { dismissReleaseUpgradeDialog, signIn } from "./_helpers";

type PendingShare = {
  route: Route;
  action: string;
  teamId: string;
};

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

const secretFixture = {
  id: "secret-race",
  name: "GitHub token",
  type: "bearer_token",
  maskedPreview: "ghp_...abcd",
  sharedWithTeams: ["platform-team"],
};

test.describe("RBAC e2e — credential team sharing", () => {
  test("uses inline common team picker and shows the selected shared team", async ({ page }) => {
    const env = rbacEnvOrSkip();
    const pendingShares: PendingShare[] = [];
    let callerTeamsRequests = 0;

    await page.route("**/api/admin/platform-config", async (route) => {
      await fulfillJson(route, {
        success: true,
        data: { release_notes: { enabled: false, release_version: "0.5.16" } },
      });
    });

    // Credential sharing must use caller-visible teams. The admin-only endpoint
    // leaves non-admin secret owners with an empty picker.
    await page.route("**/api/dynamic-agents/teams", async (route) => {
      callerTeamsRequests += 1;
      await fulfillJson(route, {
        success: true,
        data: [
          { _id: "team-1", slug: "platform-team", name: "Platform Team" },
          { _id: "team-2", slug: "observability-team", name: "Observability Team" },
          { _id: "team-3", slug: "security-team", name: "Security Team" },
        ],
      });
    });

    await page.route("**/api/credentials/secrets**", async (route) => {
      const request = route.request();
      const requestUrl = new URL(request.url());
      const method = request.method();

      if (requestUrl.pathname === "/api/credentials/secrets" && method === "GET") {
        await fulfillJson(route, { success: true, data: [secretFixture] });
        return;
      }

      if (requestUrl.pathname === "/api/credentials/secrets/secret-race" && method === "PATCH") {
        const payload = route.request().postDataJSON() as { action?: string; teamId?: string };
        if (payload.action && payload.teamId) {
          pendingShares.push({ route, action: payload.action, teamId: payload.teamId });
          return;
        }
      }

      await route.continue();
    });

    await signIn(page, env);
    await page.goto("/credentials/secrets", { waitUntil: "domcontentloaded" });
    await dismissReleaseUpgradeDialog(page);

    await expect(page.getByRole("heading", { name: "Saved Secrets" })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("button", { name: /share github token/i }).click();

    const panel = page.getByRole("region", { name: /github token team access/i });
    await expect(panel).toBeVisible();
    await expect.poll(() => callerTeamsRequests).toBe(1);
    await expect(page.getByRole("dialog", { name: /share github token/i })).toHaveCount(0);
    await expect(panel.getByText(/Choose a team that can use this saved secret/)).toBeVisible();
    await expect(panel.getByLabel("Team access")).toContainText("Platform Team");
    await expect(panel.getByLabel("Team access")).toContainText("team:platform-team");

    await panel.getByRole("combobox", { name: /team access/i }).click();
    await page.getByRole("option", { name: /Observability Team.*team:observability-team/i }).click();
    await panel.getByRole("button", { name: /grant access/i }).click();
    await expect.poll(() => pendingShares.map((share) => share.teamId)).toContain(
      "observability-team",
    );

    await panel.getByRole("combobox", { name: /team access/i }).click();
    await page.getByRole("option", { name: /Security Team.*team:security-team/i }).click();
    await panel.getByRole("button", { name: /grant access/i }).click();
    await expect.poll(() => pendingShares.map((share) => `${share.action}:${share.teamId}`).sort()).toEqual([
      "share:observability-team",
      "share:security-team",
    ]);

    const securityShare = pendingShares.find((share) => share.teamId === "security-team");
    if (!securityShare) throw new Error("security-team share request was not captured");
    await fulfillJson(securityShare.route, { success: true, data: { ok: true } });

    const observabilityShare = pendingShares.find((share) => share.teamId === "observability-team");
    if (!observabilityShare) throw new Error("observability-team share request was not captured");
    await fulfillJson(observabilityShare.route, { success: true, data: { ok: true } });

    await expect(panel.getByText(/Could not update sharing/i)).toHaveCount(0);
    await expect(panel.getByLabel("Team access")).toContainText(/Observability Team|Security Team/);

    await panel.getByRole("combobox", { name: /team access/i }).click();
    await page.getByRole("option", { name: /Platform Team.*team:platform-team/i }).click();
    await panel.getByRole("button", { name: /revoke access/i }).click();
    await expect.poll(() => pendingShares.map((share) => `${share.action}:${share.teamId}`)).toContain(
      "revoke:platform-team",
    );

    const platformRevoke = pendingShares.find((share) => share.action === "revoke");
    if (!platformRevoke) throw new Error("platform-team revoke request was not captured");
    await fulfillJson(platformRevoke.route, { success: true, data: { ok: true } });
    await expect(panel.getByText(/Could not update sharing/i)).toHaveCount(0);
  });
});
