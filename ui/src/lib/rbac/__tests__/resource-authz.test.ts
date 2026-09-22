/**
 * @jest-environment node
 */

const mockAuthorize = jest.fn();
const mockAuthorizeMany = jest.fn();
const mockListAccessible = jest.fn();

jest.mock("@/lib/authz", () => ({
  authorize: (...args: unknown[]) => mockAuthorize(...args),
  authorizeMany: (...args: unknown[]) => mockAuthorizeMany(...args),
  listAccessible: (...args: unknown[]) => mockListAccessible(...args),
}));

import { ApiError } from "@/lib/api-error";

import {
  filterResourcesByPermission,
  mcpServerRowPermissionsOrDefault,
  openFgaRelationForResourceAction,
  resolveMcpServerListPermissions,
  resourceObject,
  resourcePermissionActionToCasAction,
  requireResourcePermission,
  subjectFromSession,
} from "../resource-authz";

describe("resource-authz", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("maps legacy list/admin actions onto CAS actions", () => {
    expect(resourcePermissionActionToCasAction("list")).toBe("discover");
    expect(resourcePermissionActionToCasAction("admin")).toBe("manage");
    expect(resourcePermissionActionToCasAction("read")).toBe("read");
  });

  it("maps UI resource actions to OpenFGA check relations", () => {
    expect(openFgaRelationForResourceAction("list")).toBe("can_discover");
    expect(openFgaRelationForResourceAction("discover")).toBe("can_discover");
    expect(openFgaRelationForResourceAction("read")).toBe("can_read");
    expect(openFgaRelationForResourceAction("read-metadata")).toBe("can_read_metadata");
    expect(openFgaRelationForResourceAction("use")).toBe("can_use");
    expect(openFgaRelationForResourceAction("write")).toBe("can_write");
    expect(openFgaRelationForResourceAction("admin")).toBe("can_manage");
    expect(openFgaRelationForResourceAction("manage")).toBe("can_manage");
    expect(openFgaRelationForResourceAction("share")).toBe("can_share");
    expect(openFgaRelationForResourceAction("delete")).toBe("can_delete");
    expect(openFgaRelationForResourceAction("ingest")).toBe("can_ingest");
    expect(openFgaRelationForResourceAction("call")).toBe("can_call");
    expect(openFgaRelationForResourceAction("invoke")).toBe("can_invoke");
    expect(openFgaRelationForResourceAction("audit")).toBe("can_audit");
  });

  it("encodes provider model ids into OpenFGA-safe llm_model objects", () => {
    const modelId = "global.anthropic.claude-haiku-4-5-20251001-v1:0";
    const encoded = Buffer.from(modelId, "utf8").toString("base64url");

    expect(resourceObject("llm_model", modelId)).toBe(`llm_model:b64_${encoded}`);
    expect(resourceObject("mcp_server", "jira")).toBe("mcp_server:jira");
  });

  describe("subjectFromSession", () => {
    it("graphs interactive users under the user: namespace", () => {
      expect(subjectFromSession({ sub: " alice-sub " })).toBe("user:alice-sub");
      expect(subjectFromSession({ sub: "bob", isServiceAccount: false })).toBe("user:bob");
    });

    it("graphs client-credentials callers under the service_account: namespace", () => {
      expect(subjectFromSession({ sub: " bot-sub ", isServiceAccount: true })).toBe(
        "service_account:bot-sub",
      );
    });

    it("returns null when the subject is missing or blank", () => {
      expect(subjectFromSession({})).toBeNull();
      expect(subjectFromSession({ sub: "   " })).toBeNull();
      expect(subjectFromSession({ sub: 123 as unknown })).toBeNull();
    });

    it("does not promote catalog keys or local skills tokens to user subjects", () => {
      expect(subjectFromSession({ sub: "owner-sub", principalType: "catalog_api_key" })).toBeNull();
      expect(subjectFromSession({ sub: "owner-sub", principalType: "skills_api_key" })).toBeNull();
    });
  });

  it("checks a service-account tuple for client-credentials callers", async () => {
    // Mirrors the Slack/Webex bot reading platform settings with their
    // service-account token: the seeded grant is on service_account:<sub>,
    // so the check must use that namespace, not user:<sub>.
    await expect(
      requireResourcePermission(
        { sub: "bot-sub", isServiceAccount: true },
        { type: "system_config", id: "platform_settings", action: "read" },
        {
          check: async (tuple) => {
            expect(tuple).toEqual({
              user: "service_account:bot-sub",
              relation: "can_read",
              object: "system_config:platform_settings",
            });
            return { allowed: true };
          },
        },
      ),
    ).resolves.toBeUndefined();
  });

  it("requires a stable subject and fails closed when missing", async () => {
    await expect(
      requireResourcePermission(
        {},
        { type: "skill", id: "incident-triage", action: "read" },
        { check: async () => ({ allowed: true }) }
      )
    ).rejects.toMatchObject({
      statusCode: 401,
      code: "NO_SUBJECT",
    });
  });

  it("checks the expected OpenFGA tuple and denies on false", async () => {
    const checked: string[] = [];

    await expect(
      requireResourcePermission(
        { sub: "alice-sub", user: { email: "alice@example.test" } },
        { type: "conversation", id: "c1", action: "share" },
        {
          check: async (tuple) => {
            checked.push(`${tuple.user} ${tuple.relation} ${tuple.object}`);
            return { allowed: false };
          },
        }
      )
    ).rejects.toBeInstanceOf(ApiError);

    expect(checked).toEqual(["user:alice-sub can_share conversation:c1"]);
  });

  it("allows when OpenFGA returns true", async () => {
    await expect(
      requireResourcePermission(
        { sub: " alice-sub " },
        { type: "system_config", id: "platform_settings", action: "admin" },
        {
          check: async (tuple) => {
            expect(tuple).toEqual({
              user: "user:alice-sub",
              relation: "can_manage",
              object: "system_config:platform_settings",
            });
            return { allowed: true };
          },
        },
      ),
    ).resolves.toBeUndefined();
  });

  it("checks secret_ref use, manage, share, and audit through OpenFGA", async () => {
    const checked: string[] = [];

    for (const action of ["read-metadata", "use", "manage", "share", "audit"] as const) {
      await requireResourcePermission(
        { sub: "service-sub" },
        { type: "secret_ref", id: "secret-1", action },
        {
          check: async (tuple) => {
            checked.push(`${tuple.user} ${tuple.relation} ${tuple.object}`);
            return { allowed: true };
          },
        },
      );
    }

    expect(checked).toEqual([
      "user:service-sub can_read_metadata secret_ref:secret-1",
      "user:service-sub can_use secret_ref:secret-1",
      "user:service-sub can_manage secret_ref:secret-1",
      "user:service-sub can_share secret_ref:secret-1",
      "user:service-sub can_audit secret_ref:secret-1",
    ]);
  });

  it("does not bypass OpenFGA object checks for session-role admins", async () => {
    // bypassForOrgAdmin trusts an OpenFGA org-admin tuple, NOT a session role.
    // A `role: "admin"` claim with no org-admin tuple must still be denied.
    const check = jest.fn(async () => ({ allowed: false }));

    await expect(
      requireResourcePermission(
        { sub: "admin-sub", role: "admin" },
        { type: "admin_surface", id: "skill-scan-all", action: "admin" },
        { bypassForOrgAdmin: true, check },
      ),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "admin_surface#admin",
    });

    // The org-admin bypass probe runs first (can_manage organization:caipe),
    // then the per-resource check — both deny here.
    expect(check).toHaveBeenCalledWith({
      user: "user:admin-sub",
      relation: "can_manage",
      object: "admin_surface:skill-scan-all",
    });
  });

  it("bypasses for a real OpenFGA org admin", async () => {
    // An org admin (can_manage organization:caipe) short-circuits to allow,
    // even when the per-resource object check would deny.
    const check = jest.fn(async (tuple: { object: string }) => ({
      allowed: tuple.object === "organization:caipe",
    }));

    await expect(
      requireResourcePermission(
        { sub: "org-admin-sub", role: "admin" },
        { type: "admin_surface", id: "skill-scan-all", action: "admin" },
        { bypassForOrgAdmin: true, check },
      ),
    ).resolves.toBeUndefined();
  });

  it("filters session-role admins through OpenFGA instead of returning every resource", async () => {
    const resources = [{ id: "visible" }, { id: "denied" }];

    const visible = await filterResourcesByPermission(
      { sub: "admin-sub", role: "admin" },
      resources,
      {
        type: "mcp_server",
        action: "read",
        id: (resource) => resource.id,
      },
      {
        bypassForOrgAdmin: true,
        // Not an org admin (organization:caipe denied), so the per-resource
        // OpenFGA check still gates each resource.
        check: async (tuple) => ({ allowed: tuple.object === "mcp_server:visible" }),
      },
    );

    expect(visible).toEqual([{ id: "visible" }]);
  });

  it("filters resources by permission without leaking denied objects", async () => {
    const resources = [{ id: "a1" }, { id: "a2" }];

    const visible = await filterResourcesByPermission(
      { sub: "alice-sub" },
      resources,
      {
        type: "agent",
        action: "use",
        id: (resource) => resource.id,
      },
      {
        check: async (tuple) => ({ allowed: tuple.object === "agent:a2" }),
      }
    );

    expect(visible).toEqual([{ id: "a2" }]);
  });

  it("returns an empty resource list when the subject is missing", async () => {
    const visible = await filterResourcesByPermission(
      {},
      [{ id: "secret" }],
      {
        type: "knowledge_base",
        action: "read",
        id: (resource) => resource.id,
      },
      { check: async () => ({ allowed: true }) },
    );

    expect(visible).toEqual([]);
  });

  it("drops resources whose OpenFGA check errors", async () => {
    const visible = await filterResourcesByPermission(
      { sub: "alice-sub" },
      [{ id: "ok" }, { id: "error" }],
      {
        type: "skill",
        action: "read",
        id: (resource) => resource.id,
      },
      {
        check: async (tuple) => {
          if (tuple.object === "skill:error") {
            throw new Error("pdp unavailable for one object");
          }
          return { allowed: true };
        },
      },
    );

    expect(visible).toEqual([{ id: "ok" }]);
  });

  describe("CAS default path (no check injection)", () => {
    it("delegates requireResourcePermission to authorize", async () => {
      mockAuthorize.mockResolvedValueOnce({
        decision: "ALLOW",
        reason: "OK",
        retriable: false,
      });

      await expect(
        requireResourcePermission(
          { sub: "alice-sub" },
          { type: "mcp_server", id: "mcp-jira", action: "manage" },
        ),
      ).resolves.toBeUndefined();

      expect(mockAuthorize).toHaveBeenCalledWith({
        subject: { type: "user", id: "alice-sub" },
        resource: { type: "mcp_server", id: "mcp-jira" },
        action: "manage",
      });
    });

    it("returns 503 when CAS reports AUTHZ_UNAVAILABLE", async () => {
      mockAuthorize.mockResolvedValueOnce({
        decision: "DENY",
        reason: "AUTHZ_UNAVAILABLE",
        retriable: true,
      });

      await expect(
        requireResourcePermission(
          { sub: "alice-sub" },
          { type: "mcp_server", id: "mcp-jira", action: "read" },
        ),
      ).rejects.toMatchObject({ statusCode: 503, code: "AUTHZ_UNAVAILABLE" });
    });

    it("filters resources via listAccessible (a reverse lookup, not one authorizeMany check per candidate)", async () => {
      mockAuthorize.mockResolvedValueOnce({
        decision: "DENY",
        reason: "NO_CAPABILITY",
        retriable: false,
      });
      mockListAccessible.mockResolvedValueOnce({ accessible: ["visible"], reason: "OK" });

      const resources = [{ id: "visible" }, { id: "hidden" }];
      const visible = await filterResourcesByPermission(
        { sub: "alice-sub" },
        resources,
        { type: "mcp_server", action: "read", id: (resource) => resource.id },
      );

      expect(visible).toEqual([{ id: "visible" }]);
      expect(mockAuthorizeMany).not.toHaveBeenCalled();
      expect(mockListAccessible).toHaveBeenCalledWith(
        { type: "user", id: "alice-sub" },
        "read",
        "mcp_server",
        ["visible", "hidden"],
      );
    });

    it("fails closed (empty) rather than open when the PDP is unavailable", async () => {
      mockAuthorize.mockResolvedValueOnce({
        decision: "DENY",
        reason: "NO_CAPABILITY",
        retriable: false,
      });
      mockListAccessible.mockResolvedValueOnce({ accessible: [], reason: "AUTHZ_UNAVAILABLE" });

      const resources = [{ id: "visible" }, { id: "hidden" }];
      const visible = await filterResourcesByPermission(
        { sub: "alice-sub" },
        resources,
        { type: "mcp_server", action: "read", id: (resource) => resource.id },
      );

      expect(visible).toEqual([]);
    });

    it("batch-resolves MCP list row permissions and repair capability", async () => {
      mockAuthorize.mockReset();
      mockAuthorizeMany.mockReset();
      mockAuthorizeMany
        .mockResolvedValueOnce(
          new Map([
            ["jira", { decision: "ALLOW", reason: "OK", retriable: false }],
            ["github", { decision: "DENY", reason: "NO_CAPABILITY", retriable: false }],
          ]),
        )
        .mockResolvedValueOnce(
          new Map([
            ["jira", { decision: "DENY", reason: "NO_CAPABILITY", retriable: false }],
            ["github", { decision: "ALLOW", reason: "OK", retriable: false }],
          ]),
        )
        .mockResolvedValueOnce(
          new Map([
            ["jira", { decision: "ALLOW", reason: "OK", retriable: false }],
            ["github", { decision: "DENY", reason: "NO_CAPABILITY", retriable: false }],
          ]),
        );
      mockAuthorize.mockImplementation(async (req) => {
        if (req.resource.type === "mcp_server" && req.resource.id === "agentgateway" && req.action === "manage") {
          return { decision: "ALLOW", reason: "OK", retriable: false };
        }
        return { decision: "DENY", reason: "NO_CAPABILITY", retriable: false };
      });

      const { rows, capabilities } = await resolveMcpServerListPermissions(
        { sub: "alice-sub" },
        ["jira", "github"],
      );

      expect(rows.get("jira")).toEqual({ can_manage: true, can_invoke: false, can_discover: true });
      expect(rows.get("github")).toEqual({ can_manage: false, can_invoke: true, can_discover: false });
      expect(capabilities).toEqual({ repair_agentgateway: true });
      expect(mcpServerRowPermissionsOrDefault(rows, "missing")).toEqual({
        can_manage: false,
        can_invoke: false,
        can_discover: false,
      });
    });

    it("grants full permissions to org admins when bypassForOrgAdmin is enabled", async () => {
      mockAuthorize.mockReset();
      mockAuthorizeMany.mockReset();
      mockAuthorize.mockResolvedValue({
        decision: "ALLOW",
        reason: "OK",
        retriable: false,
      });

      const { rows, capabilities } = await resolveMcpServerListPermissions(
        { sub: "admin-sub" },
        ["jira", "github"],
        { bypassForOrgAdmin: true },
      );

      expect(mockAuthorizeMany).not.toHaveBeenCalled();
      expect(rows.get("jira")).toEqual({ can_manage: true, can_invoke: true, can_discover: true });
      expect(rows.get("github")).toEqual({ can_manage: true, can_invoke: true, can_discover: true });
      expect(capabilities).toEqual({ repair_agentgateway: true });
    });
  });
});
