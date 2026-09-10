import { encode } from "next-auth/jwt";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { FullConfig } from "@playwright/test";

export const RBAC_STORAGE_STATE_PATH = join(
  tmpdir(),
  "caipe-rbac-playwright-storage-state.json",
);

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL =
    process.env.CAIPE_UI_BASE_URL ??
    String(config.projects[0]?.use.baseURL ?? "http://localhost:3000");
  const secret = process.env.NEXTAUTH_SECRET;

  if (!secret) {
    await writeFile(
      RBAC_STORAGE_STATE_PATH,
      JSON.stringify({ cookies: [], origins: [] }),
      "utf8",
    );
    return;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const token = await encode({
    secret,
    maxAge: 60 * 60,
    token: {
      sub: "playwright-global-admin",
      name: "RBAC Test Admin",
      email: "rbac-admin@example.com",
      accessToken: "playwright-access-token",
      expiresAt: nowSeconds + 60 * 60,
      isAuthorized: true,
      role: "admin",
      canViewAdmin: true,
      canAccessDynamicAgents: true,
      org: process.env.CAIPE_ORG_KEY?.trim() || "caipe",
    },
  });

  await mkdir(dirname(RBAC_STORAGE_STATE_PATH), { recursive: true });
  await writeFile(
    RBAC_STORAGE_STATE_PATH,
    JSON.stringify({
      cookies: [
        {
          name: "next-auth.session-token",
          value: token,
          url: baseURL,
          httpOnly: true,
          sameSite: "Lax",
          expires: nowSeconds + 2 * 60 * 60,
        },
      ],
      origins: [],
    }),
    "utf8",
  );
}
