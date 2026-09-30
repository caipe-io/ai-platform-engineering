jest.mock("../manifests.generated", () => ({
  installedNativeExtensionManifests: [
    {
      id: "example-app",
      displayName: "Example App",
      description: "Example native extension",
      contractVersion: "1.1",
      hostPaths: ["/example"],
      navigation: {
        label: "Example",
        href: "/example",
        placement: "after-chat",
      },
      api: {
        appId: "example-app",
        basePath: "/api/agentic-apps/runtime/example-app",
        mounts: ["/api/example"],
      },
      auth: { mode: "app-scoped-token" },
    },
  ],
}));

import {
  nativeExtensionById,
  nativeExtensionForApiPath,
  nativeExtensionForHostPath,
  nativeExtensionForSlot,
} from "../runtime";

describe("native extension route ownership", () => {
  it("matches the claimed host root and descendants only", () => {
    expect(nativeExtensionForHostPath("/example")?.id).toBe("example-app");
    expect(nativeExtensionForHostPath("/example/detail")?.id).toBe(
      "example-app",
    );
    expect(nativeExtensionForHostPath("/examples")).toBeNull();
  });

  it("matches API mounts without capturing sibling prefixes", () => {
    expect(nativeExtensionForApiPath("/api/example/items")?.id).toBe(
      "example-app",
    );
    expect(nativeExtensionForApiPath("/api/examples")).toBeNull();
  });

  it("looks up the installed contract by id", () => {
    expect(nativeExtensionById("example-app")?.displayName).toBe(
      "Example App",
    );
    expect(nativeExtensionById("missing")).toBeNull();
  });

  it("does not claim undeclared slots", () => {
    expect(nativeExtensionForSlot("home")).toBeNull();
  });
});
