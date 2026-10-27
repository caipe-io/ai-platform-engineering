import { render, screen } from "@testing-library/react";

import type { NativeExtensionProps } from "../../../app-sdk";
import { NativeExtensionHost } from "../NativeExtensionHost";
import { installedNativeExtensions } from "../installed.generated";

jest.mock("@/lib/api-client", () => ({ apiClient: {} }));
jest.mock("@/store/chat-store", () => ({ useChatStore: {} }));
jest.mock("../NativeExtensionAssistant", () => ({
  NativeExtensionAssistant: () => <div data-testid="native-assistant" />,
}));
jest.mock("next-auth/react", () => ({ useSession: () => ({ status: "authenticated", data: { sub: "test-user", user: { email: "test-user@example.test" } } }) }));

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
        Component: ({ chat }: NativeExtensionProps) => (
          <button type="button" disabled={!chat?.assistant}>Open app assistant</button>
        ),
      },
    },
  ],
}));

describe("NativeExtensionHost", () => {
  beforeEach(() => {
    installedNativeExtensions[0].manifest.contractVersion = "2.0";
    installedNativeExtensions[0].module.contractVersion = "2.0";
    delete installedNativeExtensions[0].manifest.assistant;
  });

  it("advertises the assistant only on a route that mounts its listener, including slot changes", () => {
    installedNativeExtensions[0].manifest.assistant = {
      agentId: "example-agent", label: "Ask Example", name: "Example Assistant", overlay: "host",
    };
    const view = render(<NativeExtensionHost extensionId="example-app" slot />);
    expect(screen.getByRole("button", { name: "Open app assistant" })).toBeDisabled();
    expect(screen.queryByTestId("native-assistant")).not.toBeInTheDocument();

    view.rerender(<NativeExtensionHost extensionId="example-app" />);
    expect(screen.getByRole("button", { name: "Open app assistant" })).toBeEnabled();
    expect(screen.getByTestId("native-assistant")).toBeInTheDocument();

    view.rerender(<NativeExtensionHost extensionId="example-app" slot />);
    expect(screen.getByRole("button", { name: "Open app assistant" })).toBeDisabled();
    expect(screen.queryByTestId("native-assistant")).not.toBeInTheDocument();
  });

  it.each(["missing", "app-owned"])("omits the host capability for a %s assistant", (kind) => {
    if (kind === "app-owned") {
      installedNativeExtensions[0].manifest.assistant = {
        agentId: "example-agent", label: "Ask Example", name: "Example Assistant", overlay: "app",
      };
    }
    render(<NativeExtensionHost extensionId="example-app" />);
    expect(screen.getByRole("button", { name: "Open app assistant" })).toBeDisabled();
    expect(screen.queryByTestId("native-assistant")).not.toBeInTheDocument();
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
