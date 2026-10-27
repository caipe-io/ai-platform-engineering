/**
 * @jest-environment node
 *
 * Unit tests for the service-account Keycloak helpers (spec
 * 2026-06-05-service-accounts, T008/T009). We mock `global.fetch` (which
 * `adminFetch` calls) and assert: create reads back id+secret+sub, rotate
 * returns a new secret, delete is idempotent on 404, and errors propagate via
 * `assertOk`.
 */

function response(
  body: unknown,
  init: { ok?: boolean; status?: number; headers?: Record<string, string> } = {},
) {
  const status = init.status ?? 200;
  const headers = new Headers(init.headers);
  return {
    ok: init.ok ?? status < 400,
    status,
    statusText: String(status),
    headers,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as Response;
}

const ADMIN_BASE = "http://keycloak/admin/realms/caipe";

describe("Keycloak service-account client helpers", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      KEYCLOAK_URL: "http://keycloak",
      KEYCLOAK_REALM: "caipe",
      KEYCLOAK_ADMIN_CLIENT_ID: "caipe-platform",
      KEYCLOAK_ADMIN_CLIENT_SECRET: "secret",
    };
    global.fetch = jest.fn();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("creates a confidential client and reads back uuid, secret, and sub", async () => {
    (global.fetch as jest.Mock).mockImplementation(
      async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";

        if (url.endsWith("/protocol/openid-connect/token")) {
          return response({ access_token: "token", expires_in: 300 });
        }
        if (url === `${ADMIN_BASE}/clients` && method === "POST") {
          return response("", {
            status: 201,
            headers: { Location: `${ADMIN_BASE}/clients/new-client-uuid` },
          });
        }
        if (url === `${ADMIN_BASE}/clients/new-client-uuid/client-secret` && method === "GET") {
          return response({ type: "secret", value: "generated-secret" });
        }
        if (
          url === `${ADMIN_BASE}/clients/new-client-uuid/service-account-user` &&
          method === "GET"
        ) {
          return response({ id: "sa-user-sub" });
        }
        throw new Error(`unexpected fetch ${method} ${url}`);
      },
    );

    const { createServiceAccountClient } = await import("../keycloak-admin");
    const result = await createServiceAccountClient("Incident Bot");

    expect(result.clientUuid).toBe("new-client-uuid");
    expect(result.clientSecret).toBe("generated-secret");
    expect(result.saSub).toBe("sa-user-sub");
    expect(result.clientId).toMatch(/^caipe-sa-incident-bot-[0-9a-f]{6}$/);

    // The POST body must request a confidential service-account client.
    const postCall = (global.fetch as jest.Mock).mock.calls.find(
      ([u, i]) => String(u) === `${ADMIN_BASE}/clients` && i?.method === "POST",
    );
    const sentBody = JSON.parse((postCall![1] as RequestInit).body as string);
    expect(sentBody).toMatchObject({
      publicClient: false,
      serviceAccountsEnabled: true,
      standardFlowEnabled: false,
      directAccessGrantsEnabled: false,
      protocolMappers: [
        expect.objectContaining({
          protocolMapper: "oidc-hardcoded-claim-mapper",
          config: expect.objectContaining({
            "claim.name": "caipe_principal_type", "claim.value": "service_account",
            "access.token.claim": "true", "id.token.claim": "false",
          }),
        }),
        expect.objectContaining({
          protocolMapper: "oidc-audience-mapper",
          config: expect.objectContaining({
            "included.custom.audience": "caipe-access",
            "access.token.claim": "true", "id.token.claim": "false",
          }),
        }),
      ],
    });
    expect(sentBody.clientId).toBe(result.clientId);
  });

  it("falls back to client lookup when the create response omits a Location header", async () => {
    (global.fetch as jest.Mock).mockImplementation(
      async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";

        if (url.endsWith("/protocol/openid-connect/token")) {
          return response({ access_token: "token", expires_in: 300 });
        }
        if (url === `${ADMIN_BASE}/clients` && method === "POST") {
          return response("", { status: 201 }); // no Location header
        }
        if (url.startsWith(`${ADMIN_BASE}/clients?clientId=`) && method === "GET") {
          return response([{ id: "looked-up-uuid", clientId: "caipe-sa-bot-abc123" }]);
        }
        if (url === `${ADMIN_BASE}/clients/looked-up-uuid/client-secret` && method === "GET") {
          return response({ value: "looked-up-secret" });
        }
        if (
          url === `${ADMIN_BASE}/clients/looked-up-uuid/service-account-user` &&
          method === "GET"
        ) {
          return response({ id: "looked-up-sub" });
        }
        throw new Error(`unexpected fetch ${method} ${url}`);
      },
    );

    const { createServiceAccountClient } = await import("../keycloak-admin");
    const result = await createServiceAccountClient("bot");

    expect(result.clientUuid).toBe("looked-up-uuid");
    expect(result.clientSecret).toBe("looked-up-secret");
    expect(result.saSub).toBe("looked-up-sub");
  });

  it("propagates an error when client creation fails (assertOk)", async () => {
    (global.fetch as jest.Mock).mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/protocol/openid-connect/token")) {
        return response({ access_token: "token", expires_in: 300 });
      }
      if (url === `${ADMIN_BASE}/clients` && method === "POST") {
        return response({ error: "forbidden" }, { status: 403 });
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    });

    const { createServiceAccountClient } = await import("../keycloak-admin");
    await expect(createServiceAccountClient("bot")).rejects.toThrow(
      /createServiceAccountClient.*failed: 403/,
    );
  });

  it("regenerates the client secret and returns the new value", async () => {
    (global.fetch as jest.Mock).mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/protocol/openid-connect/token")) {
        return response({ access_token: "token", expires_in: 300 });
      }
      if (url === `${ADMIN_BASE}/clients/client-uuid/client-secret` && method === "POST") {
        return response({ type: "secret", value: "rotated-secret" });
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    });

    const { regenerateClientSecret } = await import("../keycloak-admin");
    await expect(regenerateClientSecret("client-uuid")).resolves.toBe("rotated-secret");
  });

  it("throws when regenerate returns no secret value", async () => {
    (global.fetch as jest.Mock).mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/protocol/openid-connect/token")) {
        return response({ access_token: "token", expires_in: 300 });
      }
      if (url === `${ADMIN_BASE}/clients/client-uuid/client-secret` && method === "POST") {
        return response({});
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    });

    const { regenerateClientSecret } = await import("../keycloak-admin");
    await expect(regenerateClientSecret("client-uuid")).rejects.toThrow(
      /did not return a new secret/i,
    );
  });

  it("deletes the client (204) and is idempotent on 404", async () => {
    const calls: string[] = [];
    (global.fetch as jest.Mock).mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/protocol/openid-connect/token")) {
        return response({ access_token: "token", expires_in: 300 });
      }
      if (url === `${ADMIN_BASE}/clients/gone-uuid` && method === "DELETE") {
        return response("", { status: 404 });
      }
      if (url === `${ADMIN_BASE}/clients/live-uuid` && method === "DELETE") {
        calls.push(url);
        return response("", { status: 204 });
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    });

    const { deleteServiceAccountClient } = await import("../keycloak-admin");
    await expect(deleteServiceAccountClient("live-uuid")).resolves.toBeUndefined();
    await expect(deleteServiceAccountClient("gone-uuid")).resolves.toBeUndefined();
    expect(calls).toEqual([`${ADMIN_BASE}/clients/live-uuid`]);
  });

  it("propagates a non-404 delete error (assertOk)", async () => {
    (global.fetch as jest.Mock).mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/protocol/openid-connect/token")) {
        return response({ access_token: "token", expires_in: 300 });
      }
      if (url === `${ADMIN_BASE}/clients/boom-uuid` && method === "DELETE") {
        return response({ error: "server error" }, { status: 500 });
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    });

    const { deleteServiceAccountClient } = await import("../keycloak-admin");
    await expect(deleteServiceAccountClient("boom-uuid")).rejects.toThrow(
      /deleteServiceAccountClient.*failed: 500/,
    );
  });
});

describe("getServiceAccountTokenUrl — host-reachable derivation (#55)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      // KEYCLOAK_URL is the Docker-INTERNAL host — must NOT leak into the token URL.
      KEYCLOAK_URL: "http://keycloak:7080",
      KEYCLOAK_REALM: "caipe",
    };
    delete process.env.KEYCLOAK_PUBLIC_URL;
    delete process.env.OIDC_ISSUER;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("derives from OIDC_ISSUER (browser-facing) — NOT the internal KEYCLOAK_URL", async () => {
    process.env.OIDC_ISSUER = "http://localhost:7080/realms/caipe";
    const { getServiceAccountTokenUrl } = await import("../keycloak-admin");
    expect(getServiceAccountTokenUrl()).toBe(
      "http://localhost:7080/realms/caipe/protocol/openid-connect/token",
    );
    expect(getServiceAccountTokenUrl()).not.toContain("keycloak:7080");
  });

  it("prefers KEYCLOAK_PUBLIC_URL when set", async () => {
    process.env.KEYCLOAK_PUBLIC_URL = "https://auth.example.com";
    process.env.OIDC_ISSUER = "http://localhost:7080/realms/caipe";
    const { getServiceAccountTokenUrl } = await import("../keycloak-admin");
    expect(getServiceAccountTokenUrl()).toBe(
      "https://auth.example.com/realms/caipe/protocol/openid-connect/token",
    );
  });

  it("does not double the realm segment when OIDC_ISSUER ends in /realms/<realm>", async () => {
    process.env.OIDC_ISSUER = "https://auth.example.com/realms/caipe/";
    const { getServiceAccountTokenUrl } = await import("../keycloak-admin");
    expect(getServiceAccountTokenUrl()).toBe(
      "https://auth.example.com/realms/caipe/protocol/openid-connect/token",
    );
  });

  it("PRESERVES the issuer's realm even if KEYCLOAK_REALM diverges (reviewer-a nit)", async () => {
    // The issuer IS the realm URL — its realm must win, not KEYCLOAK_REALM.
    process.env.KEYCLOAK_REALM = "other-realm";
    process.env.OIDC_ISSUER = "https://auth.example.com/realms/caipe";
    const { getServiceAccountTokenUrl } = await import("../keycloak-admin");
    expect(getServiceAccountTokenUrl()).toBe(
      "https://auth.example.com/realms/caipe/protocol/openid-connect/token",
    );
  });

  it("treats a bare-base OIDC_ISSUER (no /realms/<realm>) by appending the full token path", async () => {
    process.env.KEYCLOAK_REALM = "caipe";
    process.env.OIDC_ISSUER = "https://auth.example.com";
    const { getServiceAccountTokenUrl } = await import("../keycloak-admin");
    expect(getServiceAccountTokenUrl()).toBe(
      "https://auth.example.com/realms/caipe/protocol/openid-connect/token",
    );
  });

  it("falls back to KEYCLOAK_URL for single-URL deployments (no issuer set)", async () => {
    // No OIDC_ISSUER / KEYCLOAK_PUBLIC_URL → use the (assumed host-reachable) KEYCLOAK_URL.
    const { getServiceAccountTokenUrl } = await import("../keycloak-admin");
    expect(getServiceAccountTokenUrl()).toBe(
      "http://keycloak:7080/realms/caipe/protocol/openid-connect/token",
    );
  });
});
