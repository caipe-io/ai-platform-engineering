import { findNotificationProducer, NOTIFICATIONS_CAPABILITY } from "@/lib/agentic-apps/notification-producer";
import type { ConfiguredAgenticApp } from "@/types/agentic-app";

function app(overrides: {
  installed?: boolean;
  enabled?: boolean;
  clientId?: string | null;
  apis?: Array<{ id: string; version: string; required: boolean }>;
}): ConfiguredAgenticApp {
  const { installed = true, enabled = true, apis } = overrides;
  const clientId = overrides.clientId === undefined ? "example-client" : overrides.clientId;
  return {
    manifest: {
      consumes: { platformApis: apis ?? [{ id: NOTIFICATIONS_CAPABILITY, version: "1.0", required: false }] },
    },
    installation: {
      appId: "example-app",
      installed,
      enabled,
      ...(clientId ? { bindings: { serviceAccountClientId: clientId } } : {}),
    },
  } as unknown as ConfiguredAgenticApp;
}

describe("findNotificationProducer", () => {
  it("finds the installed, enabled app that declares the capability and is bound to the client", () => {
    const apps = [app({})];
    expect(findNotificationProducer("example-client", apps)).toBe(apps[0]);
  });

  it.each([
    ["the app is not installed", app({ installed: false })],
    ["the app is disabled", app({ enabled: false })],
    ["the manifest does not declare the capability", app({ apis: [{ id: "host.theme", version: "1.0", required: true }] })],
    ["the capability is declared at another version", app({ apis: [{ id: NOTIFICATIONS_CAPABILITY, version: "2.0", required: false }] })],
    ["the installation names no client", app({ clientId: null })],
    ["the installation names another client", app({ clientId: "other-client" })],
  ])("finds nothing when %s", (_name, candidate) => {
    expect(findNotificationProducer("example-client", [candidate])).toBeNull();
  });

  it("finds nothing for a caller with no client id", () => {
    expect(findNotificationProducer(undefined, [app({})])).toBeNull();
    expect(findNotificationProducer("", [app({})])).toBeNull();
  });
});
