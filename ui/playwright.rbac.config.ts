/**
 * Playwright config for the RBAC e2e harness.
 *
 * Scope: this config is intentionally separate from any future
 * application-wide playwright config. It only runs the specs under
 * `e2e/rbac/` and only when RUN_RBAC_E2E=1, so that day-to-day
 * `npm test` and CI Jest jobs are not affected.
 *
 * Required runtime env vars (validated in tests/_env.ts):
 *   RUN_RBAC_E2E=1            — enable the suite (otherwise specs skip)
 *   CAIPE_UI_BASE_URL         — e.g. http://localhost:3000
 *   KEYCLOAK_URL              — e.g. http://localhost:8080
 *   KEYCLOAK_REALM            — e.g. caipe
 *   RBAC_USER_EMAIL           — fixture user with chat_user role
 *   RBAC_USER_PASSWORD        — password for that user
 *   RBAC_NOACCESS_USER_EMAIL  — fixture user with NO chat_user role
 *   RBAC_NOACCESS_USER_PASSWORD
 *
 * To run:
 *   RUN_RBAC_E2E=1 \
 *   CAIPE_UI_BASE_URL=http://localhost:3000 \
 *   KEYCLOAK_URL=http://localhost:8080 \
 *   KEYCLOAK_REALM=caipe \
 *   RBAC_USER_EMAIL=... RBAC_USER_PASSWORD=... \
 *   RBAC_NOACCESS_USER_EMAIL=... RBAC_NOACCESS_USER_PASSWORD=... \
 *   npx playwright test --config=playwright.rbac.config.ts
 */

import { defineConfig, devices } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

const shellEnvKeys = new Set(Object.keys(process.env));

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const separator = normalized.indexOf("=");
    if (separator <= 0) continue;
    const key = normalized.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || shellEnvKeys.has(key)) continue;
    process.env[key] = unquoteEnvValue(normalized.slice(separator + 1));
  }
}

loadEnvFile(resolve(__dirname, "..", ".env"));
loadEnvFile(resolve(__dirname, ".env"));
loadEnvFile(resolve(__dirname, ".env.local"));

export default defineConfig({
  testDir: "./e2e/rbac",
  // Sequential by default — these tests share a Keycloak realm and
  // some flip global toggles (e.g. PDP-down). Parallelizing them
  // would create heisenbugs.
  workers: 1,
  fullyParallel: false,
  // Generous timeout: Keycloak login + Duo SSO redirect chain can be
  // slow on a cold stack.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.CAIPE_UI_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
