import { render, screen } from "@testing-library/react";

import { NativeExtensionHost } from "../NativeExtensionHost";
import { installedNativeExtensions } from "../installed.generated";

jest.mock("../host-chat", () => ({ createHostChatCapability: () => ({ Panel: () => null }) }));

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
        contractVersion: "2.0",
        hostPaths: ["/example"],
        api: { basePath: "/api/example" },
      },
      module: {
        contractVersion: "2.0",
        Component: () => null,
      },
    },
  ],
}));

describe("NativeExtensionHost", () => {
  beforeEach(() => {
    installedNativeExtensions[0].manifest.contractVersion = "2.0";
    installedNativeExtensions[0].module.contractVersion = "2.0";
  });

  it("scrolls long native app content inside the fixed CAIPE shell", () => {
    const { container } = render(
      <NativeExtensionHost extensionId="example-app" slot />,
    );

    expect(container.querySelector("[data-native-extension='example-app']")).toHaveClass(
      "min-h-0",
      "overflow-y-auto",
    );
  });

  it("keeps legacy 1.1 modules working only with matching descriptors", () => {
    installedNativeExtensions[0].manifest.contractVersion = "1.1";
    installedNativeExtensions[0].module.contractVersion = "1.1";
    const { container } = render(<NativeExtensionHost extensionId="example-app" slot />);
    expect(container.querySelector("[data-native-extension='example-app']")).not.toBeNull();
  });

  it("does not mount mismatched CAIPE App Contract declarations", () => {
    installedNativeExtensions[0].module.contractVersion = "1.1";
    render(<NativeExtensionHost extensionId="example-app" slot />);
    expect(screen.getByText("Native extension is not installed.")).toBeInTheDocument();
  });

  it("rejects unknown CAIPE App Contract versions even when the manifest and module agree", () => {
    Object.assign(installedNativeExtensions[0].manifest, { contractVersion: "3.0" });
    Object.assign(installedNativeExtensions[0].module, { contractVersion: "3.0" });
    render(<NativeExtensionHost extensionId="example-app" slot />);
    expect(screen.getByText("Native extension is not installed.")).toBeInTheDocument();
  });
});
