const mockIsBootstrapAdmin = jest.fn();
const mockCheckOpenFgaTuple = jest.fn();

jest.mock("@/lib/auth-config", () => ({
  isBootstrapAdmin: (...args: unknown[]) => mockIsBootstrapAdmin(...args),
}));

jest.mock("@/lib/rbac/openfga", () => ({
  checkOpenFgaTuple: (...args: unknown[]) => mockCheckOpenFgaTuple(...args),
}));

import { canStartUserImpersonation } from "../impersonation-policy";

describe("impersonation policy", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ADMIN_ALLOW_IMPERSONATION;
    mockIsBootstrapAdmin.mockReturnValue(false);
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true });
  });

  afterAll(() => {
    delete process.env.ADMIN_ALLOW_IMPERSONATION;
  });

  it("fails closed when the allowlist is not configured", async () => {
    await expect(canStartUserImpersonation({
      sub: "admin-sub",
      user: { email: "admin@example.com" },
    })).resolves.toBe(false);
    expect(mockCheckOpenFgaTuple).not.toHaveBeenCalled();
  });

  it("matches allowlisted emails case-insensitively", async () => {
    process.env.ADMIN_ALLOW_IMPERSONATION = " other@example.com, ADMIN@example.com ";

    await expect(canStartUserImpersonation({
      sub: "admin-sub",
      user: { email: "admin@EXAMPLE.com" },
    })).resolves.toBe(true);
    expect(mockCheckOpenFgaTuple).toHaveBeenCalledWith({
      user: "user:admin-sub",
      relation: "admin",
      object: "team:super-admins",
    });
  });

  it("allows an allowlisted bootstrap superadmin", async () => {
    process.env.ADMIN_ALLOW_IMPERSONATION = "admin@example.com";
    mockIsBootstrapAdmin.mockReturnValue(true);

    await expect(canStartUserImpersonation({
      sub: "admin-sub",
      user: { email: "admin@example.com" },
    })).resolves.toBe(true);
    expect(mockCheckOpenFgaTuple).not.toHaveBeenCalled();
  });

  it("denies an allowlisted organization admin who is not a superadmin", async () => {
    process.env.ADMIN_ALLOW_IMPERSONATION = "admin@example.com";
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });

    await expect(canStartUserImpersonation({
      sub: "admin-sub",
      user: { email: "admin@example.com" },
    })).resolves.toBe(false);
  });

  it("fails closed when the superadmin lookup fails", async () => {
    process.env.ADMIN_ALLOW_IMPERSONATION = "admin@example.com";
    mockCheckOpenFgaTuple.mockRejectedValue(new Error("OpenFGA unavailable"));

    await expect(canStartUserImpersonation({
      sub: "admin-sub",
      user: { email: "admin@example.com" },
    })).resolves.toBe(false);
  });
});
