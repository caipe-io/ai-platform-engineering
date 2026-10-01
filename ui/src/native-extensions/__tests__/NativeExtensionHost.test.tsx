import { render } from "@testing-library/react";

import { NativeExtensionHost } from "../NativeExtensionHost";

jest.mock("next/navigation", () => ({
  usePathname: () => "/example",
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock("../installed.generated", () => ({
  installedNativeExtensions: [
    {
      manifest: {
        id: "example-app",
        displayName: "Example App",
        contractVersion: "1.1",
        hostPaths: ["/example"],
        api: { basePath: "/api/example" },
      },
      module: {
        contractVersion: "1.1",
        Component: () => null,
      },
    },
  ],
}));

describe("NativeExtensionHost", () => {
  it("scrolls long native app content inside the fixed CAIPE shell", () => {
    const { container } = render(
      <NativeExtensionHost extensionId="example-app" slot />,
    );

    expect(container.querySelector("[data-native-extension='example-app']")).toHaveClass(
      "min-h-0",
      "overflow-y-auto",
    );
  });
});
