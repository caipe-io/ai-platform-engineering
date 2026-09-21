/**
 * @jest-environment node
 *
 * Security-critical: these helpers enforce the CAS trust boundary. The
 * binding rule must FAIL CLOSED.
 */

const mockAuthorize = jest.fn();
const mockEmitGrantAudit = jest.fn();

// assisted-by Codex Codex-sonnet-4-6

jest.mock("../index", () => ({
  authorize: (...args: unknown[]) => mockAuthorize(...args),
}));
jest.mock("../audit", () => ({
  emitGrantAudit: (...args: unknown[]) => mockEmitGrantAudit(...args),
}));

import {
  HttpAuthzError,
  decisionContext,
  enforceSubjectBinding,
  isValidId,
  parseAction,
  parseGrantee,
  parseGrantIntent,
  parseResource,
  parseResourceType,
  parseSubject,
  requireAuditCapability,
  requireManage,
  resolveCaller,
  type Caller,
} from "../http";

beforeEach(() => jest.clearAllMocks());

describe("resolveCaller — fail closed", () => {
  it("returns null when session is missing or not an object", () => {
    expect(resolveCaller(null)).toBeNull();
    expect(resolveCaller(undefined)).toBeNull();
    expect(resolveCaller("nope")).toBeNull();
  });

  it("returns null when there is no stable sub (catalog-key / local-skills token)", () => {
    expect(resolveCaller({ role: "user", catalogKey: "abc" })).toBeNull();
    expect(resolveCaller({ sub: "owner-sub", principalType: "catalog_api_key" })).toBeNull();
    expect(resolveCaller({ sub: "owner-sub", principalType: "skills_api_key" })).toBeNull();
    expect(resolveCaller({ sub: "" })).toBeNull();
    expect(resolveCaller({ sub: "   " })).toBeNull();
  });

  it("resolves a user subject from a bearer/cookie session", () => {
    expect(resolveCaller({ sub: "alice-sub" })).toEqual({ type: "user", id: "alice-sub" });
  });

  it("graphs an explicit service account under service_account:", () => {
    expect(resolveCaller({ sub: "bot-sa", isServiceAccount: true })).toEqual({
      type: "service_account",
      id: "bot-sa",
    });
  });
});

describe("decisionContext", () => {
  it("derives tenant from session.org and mints a correlation id", () => {
    const ctx = decisionContext({ org: "acme" });
    expect(ctx.tenantId).toBe("acme");
    expect(typeof ctx.correlationId).toBe("string");
  });
  it("leaves tenant undefined when there is no org claim", () => {
    expect(decisionContext({ sub: "x" }).tenantId).toBeUndefined();
  });
  it("threads caller and x-correlation-id from the request", () => {
    const caller = { type: "user" as const, id: "alice" };
    const req = new Request("http://localhost", { headers: { "x-correlation-id": "req-99" } });
    const ctx = decisionContext({ org: "acme" }, caller, req);
    expect(ctx).toMatchObject({
      tenantId: "acme",
      correlationId: "req-99",
      caller: { type: "user", id: "alice" },
    });
  });
});

describe("isValidId — rejects OpenFGA structure and abuse", () => {
  it("accepts UUIDs, emails, and resource ids", () => {
    expect(isValidId("platform-engineer")).toBe(true);
    expect(isValidId("3f1a-9b2c")).toBe(true);
    expect(isValidId("alice@example.com")).toBe(true);
  });
  it("rejects wildcard, relation/type separators, and path traversal", () => {
    expect(isValidId("*")).toBe(false);
    expect(isValidId("agent:*")).toBe(false);
    expect(isValidId("team:eng#member")).toBe(false);
    expect(isValidId("../etc/passwd")).toBe(false);
  });
  it("rejects empty and overlong ids", () => {
    expect(isValidId("")).toBe(false);
    expect(isValidId("a".repeat(257))).toBe(false);
  });
});

describe("parsers", () => {
  it("parseSubject accepts valid and rejects bad type/id", () => {
    expect(parseSubject({ type: "user", id: "x" })).toEqual({ type: "user", id: "x" });
    expect(() => parseSubject({ type: "robot", id: "x" })).toThrow(HttpAuthzError);
    expect(() => parseSubject({ type: "user", id: "a*b" })).toThrow(HttpAuthzError);
    expect(() => parseSubject(null)).toThrow(HttpAuthzError);
  });
  it("parseResource validates type + id", () => {
    expect(parseResource({ type: "agent", id: "pe" })).toEqual({ type: "agent", id: "pe" });
    expect(() => parseResource({ type: "nope", id: "x" })).toThrow(HttpAuthzError);
  });
  it("parseResource rejects a missing object and an invalid id", () => {
    expect(() => parseResource(null)).toThrow(HttpAuthzError);
    expect(() => parseResource({ type: "agent", id: "a*b" })).toThrow(HttpAuthzError);
  });
  it("parseAction / parseResourceType validate membership", () => {
    expect(parseAction("use")).toBe("use");
    expect(parseAction("automate")).toBe("automate");
    expect(() => parseAction("frobnicate")).toThrow(HttpAuthzError);
    expect(parseResourceType("task")).toBe("task");
    expect(() => parseResourceType("nope")).toThrow(HttpAuthzError);
  });
});

describe("enforceSubjectBinding — the core control", () => {
  const caller: Caller = { type: "user", id: "alice" };

  it("allows a caller to evaluate its own subject without consulting the PDP", async () => {
    await expect(
      enforceSubjectBinding(caller, { type: "user", id: "alice" }, {}),
    ).resolves.toBeUndefined();
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it("rejects cross-subject evaluation without can_audit (403)", async () => {
    mockAuthorize.mockResolvedValue({ decision: "DENY", reason: "NO_CAPABILITY" });
    await expect(
      enforceSubjectBinding(caller, { type: "user", id: "bob" }, {}),
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
  });

  it("permits cross-subject evaluation when the caller holds can_audit", async () => {
    mockAuthorize.mockResolvedValue({ decision: "ALLOW", reason: "OK" });
    await expect(
      enforceSubjectBinding(caller, { type: "user", id: "bob" }, {}),
    ).resolves.toBeUndefined();
    expect(mockAuthorize).toHaveBeenCalledWith(
      expect.objectContaining({ action: "audit", resource: { type: "organization", id: "caipe" } }),
      expect.anything(),
    );
  });

  it("treats a type mismatch on the same id as cross-subject", async () => {
    mockAuthorize.mockResolvedValue({ decision: "DENY", reason: "NO_CAPABILITY" });
    await expect(
      enforceSubjectBinding(caller, { type: "service_account", id: "alice" }, {}),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("requireAuditCapability", () => {
  it("throws 403 without can_audit", async () => {
    mockAuthorize.mockResolvedValue({ decision: "DENY", reason: "NO_CAPABILITY" });
    await expect(requireAuditCapability({ type: "user", id: "x" }, {})).rejects.toMatchObject({
      status: 403,
    });
  });
  it("passes with can_audit", async () => {
    mockAuthorize.mockResolvedValue({ decision: "ALLOW", reason: "OK" });
    await expect(requireAuditCapability({ type: "user", id: "x" }, {})).resolves.toBeUndefined();
  });
});

describe("grant parsing", () => {
  it("parseGrantee accepts user/team/everyone and rejects bad types/ids", () => {
    expect(parseGrantee({ type: "team", id: "eng" })).toEqual({ type: "team", id: "eng" });
    expect(parseGrantee({ type: "everyone" })).toEqual({ type: "everyone" });
    expect(parseGrantee({ type: "service_account", id: "bot" })).toEqual({ type: "service_account", id: "bot" });
    expect(() => parseGrantee({ type: "nope", id: "x" })).toThrow(HttpAuthzError);
    expect(() => parseGrantee({ type: "user", id: "a*b" })).toThrow(HttpAuthzError);
    expect(() => parseGrantee(null)).toThrow(HttpAuthzError);
  });
  it("parseGrantIntent validates resource + grantee + capability", () => {
    expect(parseGrantIntent({ resource: { type: "agent", id: "pe" }, grantee: { type: "team", id: "eng" }, capability: "use" })).toEqual({
      resource: { type: "agent", id: "pe" },
      grantee: { type: "team", id: "eng" },
      capability: "use",
    });
    expect(() => parseGrantIntent({ resource: { type: "agent", id: "pe" }, grantee: { type: "team", id: "eng" }, capability: "frobnicate" })).toThrow(HttpAuthzError);
    expect(() => parseGrantIntent(null)).toThrow(HttpAuthzError);
  });

  it("parseGrantIntent rejects valid actions that the resource type does not support", () => {
    expect(() =>
      parseGrantIntent({ resource: { type: "agent", id: "pe" }, grantee: { type: "team", id: "eng" }, capability: "ingest" }),
    ).toThrow(HttpAuthzError);
  });

  it("parseGrantIntent blocks high-risk everyone grants", () => {
    expect(() =>
      parseGrantIntent({ resource: { type: "agent", id: "pe" }, grantee: { type: "everyone" }, capability: "manage" }),
    ).toThrow(HttpAuthzError);
  });

  it("parseGrantIntent blocks everyone grants for conversation discovery", () => {
    expect(() =>
      parseGrantIntent({
        resource: { type: "conversation", id: "conv-1" },
        grantee: { type: "everyone" },
        capability: "discover",
      }),
    ).toThrow(HttpAuthzError);
  });

  it("parseGrantIntent allows everyone use grants for global workflow agent access", () => {
    expect(parseGrantIntent({ resource: { type: "agent", id: "pe" }, grantee: { type: "everyone" }, capability: "use" })).toEqual({
      resource: { type: "agent", id: "pe" },
      grantee: { type: "everyone" },
      capability: "use",
    });
  });

  it("parseGrantIntent allows explicitly low-risk everyone grants", () => {
    expect(parseGrantIntent({ resource: { type: "agent", id: "pe" }, grantee: { type: "everyone" }, capability: "discover" })).toEqual({
      resource: { type: "agent", id: "pe" },
      grantee: { type: "everyone" },
      capability: "discover",
    });
  });
});

describe("requireManage (grant meta-authz)", () => {
  const caller: Caller = { type: "user", id: "admin" };
  const ctx = { caller: { type: "user" as const, id: "admin" }, tenantId: "acme", correlationId: "c-1" };
  const intent = {
    resource: { type: "agent" as const, id: "pe" },
    grantee: { type: "team" as const, id: "eng" },
    capability: "use" as const,
  };

  it("passes when the caller can manage the resource", async () => {
    mockAuthorize.mockResolvedValue({ decision: "ALLOW", reason: "OK" });
    await expect(requireManage(caller, { type: "agent", id: "pe" }, {})).resolves.toBeUndefined();
    expect(mockAuthorize).toHaveBeenCalledWith(expect.objectContaining({ action: "manage", resource: { type: "agent", id: "pe" } }), expect.anything());
    expect(mockEmitGrantAudit).not.toHaveBeenCalled();
  });

  it("passes when an organization admin lacks direct resource manage", async () => {
    mockAuthorize
      .mockResolvedValueOnce({ decision: "DENY", reason: "NO_CAPABILITY", retriable: false })
      .mockResolvedValueOnce({ decision: "ALLOW", reason: "OK", retriable: false, via: "org_admin" });

    await expect(requireManage(caller, { type: "agent", id: "pe" }, ctx)).resolves.toBeUndefined();

    expect(mockAuthorize).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ action: "manage", resource: { type: "agent", id: "pe" } }),
      ctx,
    );
    expect(mockAuthorize).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ action: "manage", resource: { type: "organization", id: "caipe" } }),
      ctx,
    );
    expect(mockEmitGrantAudit).not.toHaveBeenCalled();
  });

  it("throws 403 when the caller cannot manage the resource", async () => {
    mockAuthorize.mockResolvedValue({ decision: "DENY", reason: "NO_CAPABILITY" });
    await expect(requireManage(caller, { type: "agent", id: "pe" }, {})).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(mockEmitGrantAudit).not.toHaveBeenCalled();
  });
  it("throws 503 when the manage check is retriably unavailable", async () => {
    mockAuthorize.mockResolvedValue({ decision: "DENY", reason: "AUTHZ_UNAVAILABLE", retriable: true });
    await expect(requireManage(caller, { type: "agent", id: "pe" }, {})).rejects.toMatchObject({
      status: 503,
      code: "AUTHZ_UNAVAILABLE",
    });
  });
  it("audits failed grant attempts when meta-authz denies", async () => {
    mockAuthorize.mockResolvedValue({ decision: "DENY", reason: "NO_CAPABILITY" });
    await expect(
      requireManage(caller, intent.resource, ctx, { operation: "grant", intent }),
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(mockEmitGrantAudit).toHaveBeenCalledWith("grant", intent, ctx, {
      outcome: "error",
      reasonCode: "NO_CAPABILITY",
    });
  });
});
