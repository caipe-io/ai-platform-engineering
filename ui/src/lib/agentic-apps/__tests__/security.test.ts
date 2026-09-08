/** @jest-environment node */

import { canLaunchAgenticApp } from "../access";
import { resolveAgenticAppHttpPolicyAction } from "../policy-routing";
import { buildPublicAgenticApp } from "../public-app";
import { isHostControlledAgenticAppRequestHeader } from "../request-headers";
import {
  buildAgenticAppTargetUrl,
  rewriteAgenticAppResponseLocation,
} from "../runtime";
import { mintAgenticAppToken, verifyAgenticAppToken } from "../tokens";
import type { ConfiguredAgenticApp } from "@/types/agentic-app";
import { createWeatherJwtVerifier } from "../../../../examples/external-apps/weather/auth.mjs";

const app: ConfiguredAgenticApp = {
  manifest: {
    id: "example-app",
    displayName: "Example App",
    description: "Example",
    apiVersion: "1.0",
    runtime: {
      kind: "proxied-next-zone",
      origin: "http://example-app.example.svc",
      mountPath: "/apps/example-app",
    },
    surfaces: { showInHub: true },
    access: {
      requiredRoles: ["user"],
      tokenScopes: ["example-app:read", "example-app:run"],
      policyActions: [
        { action: "proxy:GET", defaultEffect: "allow", requiredScopes: ["example-app:read"] },
        { action: "create", method: "POST", path: "/api/items", defaultEffect: "allow", requiredScopes: ["example-app:run"] },
      ],
    },
  },
  installation: {
    appId: "example-app",
    packageId: "example-app",
    installed: true,
    enabled: true,
    visible: true,
  },
};

describe("External Apps security contracts", () => {
  const previousSecret = process.env.AGENTIC_APP_TOKEN_SECRET;

  beforeAll(() => {
    process.env.AGENTIC_APP_TOKEN_SECRET = "dedicated-test-secret-long-enough";
  });

  afterAll(() => {
    if (previousSecret === undefined) delete process.env.AGENTIC_APP_TOKEN_SECRET;
    else process.env.AGENTIC_APP_TOKEN_SECRET = previousSecret;
  });

  it("mints identity and scopes for exactly one app", async () => {
    const minted = await mintAgenticAppToken({
      appId: "example-app",
      subject: "stable-subject",
      name: "  Test User  ",
      email: "test-user@example.com",
      scopes: ["example-app:read"],
      decisionId: "decision-1",
      correlationId: "correlation-1",
    });
    await expect(verifyAgenticAppToken(minted.token, "example-app")).resolves.toEqual(
      expect.objectContaining({
        sub: "stable-subject",
        name: "Test User",
        aud: "agentic-app:example-app",
        app_id: "example-app",
        scp: ["example-app:read"],
      }),
    );
    await expect(verifyAgenticAppToken(minted.token, "other-app")).rejects.toThrow(
      /audience/,
    );
  });

  it("mints a token accepted by the independent Weather example verifier", async () => {
    const minted = await mintAgenticAppToken({
      appId: "weather",
      subject: "stable-subject",
      scopes: ["weather:read"],
      decisionId: "decision-weather",
      correlationId: "correlation-weather",
    });
    const verifyWeatherRequest = createWeatherJwtVerifier({
      secret: process.env.AGENTIC_APP_TOKEN_SECRET,
    });

    expect(
      verifyWeatherRequest(
        { authorization: `Bearer ${minted.token}` },
        "weather:read",
      ),
    ).toEqual(
      expect.objectContaining({
        ok: true,
        identity: expect.objectContaining({
          subject: "stable-subject",
          appId: "weather",
          scopes: ["weather:read"],
        }),
      }),
    );
  });

  it("rejects an undersized signing key", async () => {
    process.env.AGENTIC_APP_TOKEN_SECRET = "too-short";
    try {
      await expect(
        mintAgenticAppToken({
          appId: "example-app",
          subject: "stable-subject",
          scopes: ["example-app:read"],
          decisionId: "decision-1",
          correlationId: "correlation-1",
        }),
      ).rejects.toThrow(/at least 32 bytes/);
    } finally {
      process.env.AGENTIC_APP_TOKEN_SECRET = "dedicated-test-secret-long-enough";
    }
  });

  it("normalizes surrounding whitespace in the shared signing key", async () => {
    process.env.AGENTIC_APP_TOKEN_SECRET = "  dedicated-test-secret-long-enough  \n";
    try {
      const minted = await mintAgenticAppToken({
        appId: "example-app",
        subject: "stable-subject",
        scopes: ["example-app:read"],
        decisionId: "decision-1",
        correlationId: "correlation-1",
      });
      process.env.AGENTIC_APP_TOKEN_SECRET = "dedicated-test-secret-long-enough";
      await expect(
        verifyAgenticAppToken(minted.token, "example-app"),
      ).resolves.toEqual(expect.objectContaining({ sub: "stable-subject" }));
    } finally {
      process.env.AGENTIC_APP_TOKEN_SECRET = "dedicated-test-secret-long-enough";
    }
  });

  it("strips caller-controlled identity while retaining ordinary app headers", () => {
    for (const header of [
      "authorization",
      "content-length",
      "cookie",
      "keep-alive",
      "upgrade",
      "x-caipe-user",
      "x-auth-request-email",
      "x-forwarded-user",
      "x-remote-user",
      "x-example-app-subject",
      "x-example-app-name",
      "x-example-app-role",
      "x-example-app-roles",
      "x-example-app-user-id",
      "x-example-app-positions",
    ]) {
      expect(isHostControlledAgenticAppRequestHeader(header, "example-app")).toBe(true);
    }
    expect(isHostControlledAgenticAppRequestHeader("x-example-app-feature", "example-app")).toBe(false);
  });

  it("uses exact policies for writes and fails closed on undeclared paths", () => {
    expect(resolveAgenticAppHttpPolicyAction(app.manifest, "GET", "/assets/app.js")?.action).toBe("proxy:GET");
    expect(resolveAgenticAppHttpPolicyAction(app.manifest, "POST", "/api/items")?.action).toBe("create");
    expect(resolveAgenticAppHttpPolicyAction(app.manifest, "POST", "/api/other")).toBeUndefined();
  });

  it("keeps private runtime coordinates out of the public catalog", () => {
    const publicApp = buildPublicAgenticApp(app, true);
    expect(publicApp).toEqual(expect.objectContaining({ appId: "example-app", href: "/apps/example-app" }));
    expect(JSON.stringify(publicApp)).not.toContain("example.svc");
    expect(publicApp).not.toHaveProperty("runtime");
    expect(publicApp).not.toHaveProperty("origin");
  });

  it("requires role access and builds an encoded private target URL", () => {
    expect(canLaunchAgenticApp(app, { role: "user" })).toBe(true);
    expect(canLaunchAgenticApp(app, { role: "admin" })).toBe(true);
    expect(canLaunchAgenticApp(app, { role: "viewer" })).toBe(false);
    expect(
      buildAgenticAppTargetUrl(app, ["api", "items", "with space"], "https://host.example/apps?limit=2").toString(),
    ).toBe("http://example-app.example.svc/api/items/with%20space?limit=2");
  });

  it("keeps runtime redirects under the public app mount", () => {
    const target = new URL("http://example-app.example.svc/current");
    expect(
      rewriteAgenticAppResponseLocation(
        app,
        "example-app",
        target,
        "/apps/example-app/items?limit=2#result",
      ),
    ).toBe("/apps/example-app/items?limit=2#result");
    expect(
      rewriteAgenticAppResponseLocation(app, "example-app", target, "/login"),
    ).toBe("/apps/example-app/login");
    expect(
      rewriteAgenticAppResponseLocation(
        app,
        "example-app",
        target,
        "https://identity.example/login",
      ),
    ).toBe("https://identity.example/login");
    expect(
      rewriteAgenticAppResponseLocation(
        app,
        "example-app",
        target,
        "javascript:alert(1)",
      ),
    ).toBeNull();
  });
});
