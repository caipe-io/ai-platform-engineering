import { render, screen } from "@testing-library/react";
import { getServerSession } from "next-auth";
import { notFound, redirect } from "next/navigation";

import CredentialsLayout from "../layout";

jest.mock("next-auth", () => ({
  getServerSession: jest.fn(),
}));

jest.mock("next/navigation", () => ({
  notFound: jest.fn(() => {
    throw new Error("notFound");
  }),
  redirect: jest.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
}));

jest.mock("@/lib/auth-config", () => ({
  authOptions: {},
}));

jest.mock("@/lib/feature-flags/credentials", () => ({
  getCredentialFeatureConfig: jest.fn(() => ({ enabled: true })),
  isUserConnectionsEnabled: jest.fn(() => true),
}));

const mockCheckOpenFgaTuple = jest.fn();
jest.mock("@/lib/rbac/openfga", () => ({
  checkOpenFgaTuple: (...args: unknown[]) => mockCheckOpenFgaTuple(...args),
}));

jest.mock("@/lib/rbac/organization", () => ({
  organizationObjectId: () => "organization:caipe",
}));

const mockGetServerSession = getServerSession as jest.MockedFunction<typeof getServerSession>;
const mockRedirect = redirect as unknown as jest.Mock;
const mockNotFound = notFound as unknown as jest.Mock;

describe("CredentialsLayout", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true });
  });

  it("redirects unauthenticated visitors to the sign-in page", async () => {
    mockGetServerSession.mockResolvedValue(null);

    await expect(CredentialsLayout({ children: <div>Credentials workspace</div> })).rejects.toThrow(
      "redirect:/login?callbackUrl=%2Fcredentials",
    );

    expect(mockRedirect).toHaveBeenCalledWith("/login?callbackUrl=%2Fcredentials");
  });

  it("renders the credentials workspace for signed-in users", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "user@example.com" },
      sub: "user-sub",
      expires: "2026-05-22T00:00:00.000Z",
    });

    render(await CredentialsLayout({ children: <div>Credentials workspace</div> }));

    expect(mockCheckOpenFgaTuple).toHaveBeenCalledWith({
      user: "user:user-sub",
      relation: "can_use",
      object: "organization:caipe",
    });
    expect(screen.getByText("Credentials workspace")).toBeInTheDocument();
  });

  it("hides the credentials workspace when the signed-in user is not an org member", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "user@example.com" },
      sub: "user-sub",
      expires: "2026-05-22T00:00:00.000Z",
    });
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });

    await expect(
      CredentialsLayout({ children: <div>Credentials workspace</div> }),
    ).rejects.toThrow("notFound");

    expect(mockNotFound).toHaveBeenCalled();
  });
});
