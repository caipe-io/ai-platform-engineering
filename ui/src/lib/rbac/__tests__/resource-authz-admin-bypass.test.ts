/**
 * @jest-environment node
 */

jest.mock("@/lib/authz", () => ({
  authorize: jest.fn(),
  authorizeMany: jest.fn(),
}));

import { ApiError } from "@/lib/api-error";

import {
  filterResourcesByPermission,
  requireAgentPermission,
  requireResourcePermission,
  requireSkillPermission,
} from "../resource-authz";

// The `bypassForOrgAdmin: true` option lets the resource-permission helpers
// short-circuit to allow when the caller holds
// `user:<sub> can_manage organization:<key>` in OpenFGA. Default is off.
// Setting the env var `RAG_ADMIN_BYPASS_DISABLED=true` forces the bypass
// off everywhere as a kill switch.

describe("resource-authz org-admin bypass", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv, CAIPE_ORG_KEY: "caipe" };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("requireResourcePermission", () => {
    it("requires the per-resource check when bypassForOrgAdmin is false", async () => {
      const check = jest.fn(async () => ({ allowed: false }));
      await expect(
        requireResourcePermission(
          { sub: "alice-sub" },
          { type: "knowledge_base", id: "kb1", action: "read" },
          { check },
        ),
      ).rejects.toBeInstanceOf(ApiError);
      expect(check).toHaveBeenCalledTimes(1);
      expect(check).toHaveBeenCalledWith({
        user: "user:alice-sub",
        relation: "can_read",
        object: "knowledge_base:kb1",
      });
    });

    it("allows when bypassForOrgAdmin is true and the org-admin check passes", async () => {
      const check = jest.fn(async (tuple) => {
        if (tuple.object === "organization:caipe" && tuple.relation === "can_manage") {
          return { allowed: true };
        }
        return { allowed: false };
      });
      await expect(
        requireResourcePermission(
          { sub: "admin-sub" },
          { type: "knowledge_base", id: "kb1", action: "read" },
          { bypassForOrgAdmin: true, check },
        ),
      ).resolves.toBeUndefined();
      expect(check).toHaveBeenCalledWith({
        user: "user:admin-sub",
        relation: "can_manage",
        object: "organization:caipe",
      });
    });

    it("falls through to the per-resource check when org-admin lookup is false", async () => {
      const check = jest.fn(async (tuple) => {
        if (tuple.object === "organization:caipe") return { allowed: false };
        if (tuple.object === "knowledge_base:kb1" && tuple.relation === "can_read") {
          return { allowed: true };
        }
        return { allowed: false };
      });
      await expect(
        requireResourcePermission(
          { sub: "alice-sub" },
          { type: "knowledge_base", id: "kb1", action: "read" },
          { bypassForOrgAdmin: true, check },
        ),
      ).resolves.toBeUndefined();
    });

    it("respects the RAG_ADMIN_BYPASS_DISABLED kill switch", async () => {
      process.env.RAG_ADMIN_BYPASS_DISABLED = "true";
      const check = jest.fn(async (tuple) => {
        if (tuple.object === "organization:caipe") return { allowed: true };
        return { allowed: false };
      });
      await expect(
        requireResourcePermission(
          { sub: "admin-sub" },
          { type: "knowledge_base", id: "kb1", action: "read" },
          { bypassForOrgAdmin: true, check },
        ),
      ).rejects.toBeInstanceOf(ApiError);
      // Org-admin tuple was never queried because the kill switch fired first.
      expect(check).not.toHaveBeenCalledWith({
        user: "user:admin-sub",
        relation: "can_manage",
        object: "organization:caipe",
      });
    });
  });

  describe("filterResourcesByPermission", () => {
    it("returns every resource when bypassForOrgAdmin is true and org-admin check passes", async () => {
      const check = jest.fn(async (tuple) => {
        if (tuple.object === "organization:caipe") return { allowed: true };
        return { allowed: false };
      });
      const visible = await filterResourcesByPermission(
        { sub: "admin-sub" },
        [{ id: "a" }, { id: "b" }, { id: "c" }],
        { type: "knowledge_base", action: "read", id: (resource) => resource.id },
        { bypassForOrgAdmin: true, check },
      );
      expect(visible).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
      // Per-resource checks were skipped because the org-admin tuple was allowed.
      expect(check).toHaveBeenCalledTimes(1);
    });

    it("falls back to per-resource checks when bypassForOrgAdmin is false", async () => {
      const check = jest.fn(async (tuple) => ({ allowed: tuple.object === "knowledge_base:b" }));
      const visible = await filterResourcesByPermission(
        { sub: "alice-sub" },
        [{ id: "a" }, { id: "b" }],
        { type: "knowledge_base", action: "read", id: (resource) => resource.id },
        { check },
      );
      expect(visible).toEqual([{ id: "b" }]);
    });

    it("falls back to per-resource checks when bypassForOrgAdmin lookup denies", async () => {
      const check = jest.fn(async (tuple) => {
        if (tuple.object === "organization:caipe") return { allowed: false };
        return { allowed: tuple.object === "knowledge_base:a" };
      });
      const visible = await filterResourcesByPermission(
        { sub: "alice-sub" },
        [{ id: "a" }, { id: "b" }],
        { type: "knowledge_base", action: "read", id: (resource) => resource.id },
        { bypassForOrgAdmin: true, check },
      );
      expect(visible).toEqual([{ id: "a" }]);
    });

    it("respects the RAG_ADMIN_BYPASS_DISABLED kill switch", async () => {
      process.env.RAG_ADMIN_BYPASS_DISABLED = "1";
      const check = jest.fn(async (tuple) => ({
        allowed: tuple.object === "knowledge_base:a",
      }));
      const visible = await filterResourcesByPermission(
        { sub: "admin-sub" },
        [{ id: "a" }, { id: "b" }],
        { type: "knowledge_base", action: "read", id: (resource) => resource.id },
        { bypassForOrgAdmin: true, check },
      );
      expect(visible).toEqual([{ id: "a" }]);
      expect(check).not.toHaveBeenCalledWith(
        expect.objectContaining({ object: "organization:caipe" }),
      );
    });
  });

  describe("requireAgentPermission", () => {
    it("does not let organization admins bypass the per-agent tuple", async () => {
      const check = jest.fn(async (tuple) => {
        if (tuple.object === "organization:caipe" && tuple.relation === "can_manage") {
          return { allowed: true };
        }
        return { allowed: false };
      });
      await expect(
        requireAgentPermission({ sub: "admin-sub" }, "hello-world", "write", { check }),
      ).rejects.toBeInstanceOf(ApiError);
      expect(check).toHaveBeenCalledWith({
        user: "user:admin-sub",
        relation: "can_write",
        object: "agent:hello-world",
      });
      expect(check).not.toHaveBeenCalledWith(expect.objectContaining({
        object: "organization:caipe",
      }));
    });

    it("falls through to per-agent checks when the caller is not an org admin", async () => {
      const check = jest.fn(async (tuple) => {
        if (tuple.object === "organization:caipe") return { allowed: false };
        if (tuple.object === "agent:agent-1" && tuple.relation === "can_write") {
          return { allowed: true };
        }
        return { allowed: false };
      });
      await expect(
        requireAgentPermission({ sub: "alice-sub" }, "agent-1", "write", { check }),
      ).resolves.toBeUndefined();
      expect(check).toHaveBeenCalledWith({
        user: "user:alice-sub",
        relation: "can_write",
        object: "agent:agent-1",
      });
    });
  });

  describe("requireSkillPermission", () => {
    it("allows app admins with admin_surface:skills#can_manage without a per-skill tuple", async () => {
      const check = jest.fn(async (tuple) => {
        if (tuple.object === "admin_surface:skills" && tuple.relation === "can_manage") {
          return { allowed: true };
        }
        return { allowed: false };
      });
      await expect(
        requireSkillPermission(
          { sub: "admin-sub", role: "admin" },
          "skill-hello",
          "write",
          { check },
        ),
      ).resolves.toBeUndefined();
      expect(check).toHaveBeenCalledWith({
        user: "user:admin-sub",
        relation: "can_manage",
        object: "admin_surface:skills",
      });
    });
  });
});
