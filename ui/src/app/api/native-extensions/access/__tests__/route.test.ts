/**
 * @jest-environment node
 */
jest.mock("@/native-extensions/access", () => ({
  canEnterNativeExtension: jest.fn(),
}));
jest.mock("@/lib/agentic-apps/config", () => ({ getConfiguredAgenticApp: (id: string) => ({ installation: { visible: id !== "internal" } }) }));
jest.mock("@/native-extensions/manifests.generated", () => ({
  installedNativeExtensionManifests: [
    { id: "allowed", navigation: { href: "/allowed" } },
    { id: "denied", navigation: { href: "/denied" } },
    { id: "hidden", navigation: undefined },
    { id: "internal", navigation: { href: "/internal" } },
  ],
}));

import { canEnterNativeExtension } from "@/native-extensions/access";
import { GET } from "../route";

describe("/api/native-extensions/access", () => {
  it("returns only authorized native navigation and disables caching", async () => {
    jest.mocked(canEnterNativeExtension).mockImplementation(async (id) => id === "allowed");

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ ids: ["allowed"] });
    expect(canEnterNativeExtension).toHaveBeenCalledTimes(2);
  });

  it("fails closed if an access check throws", async () => {
    jest.mocked(canEnterNativeExtension).mockRejectedValue(new Error("authorization unavailable"));

    const response = await GET();

    await expect(response.json()).resolves.toEqual({ ids: [] });
  });
});
