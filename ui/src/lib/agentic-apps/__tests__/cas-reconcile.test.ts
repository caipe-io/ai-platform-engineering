import type { ConfiguredAgenticApp } from "@/types/agentic-app";

import { buildConfiguredAgenticAppCasTupleDiff } from "../cas-reconcile";

function configuredApp(
  id: string,
  visible: boolean,
  authorization = true,
): ConfiguredAgenticApp {
  return {
    manifest: {
      id,
      displayName: id,
      description: "Example",
      apiVersion: "1.0",
      runtime: {
        kind: "proxied-next-zone",
        origin: "https://app.example.test",
        mountPath: `/apps/${id}`,
      },
      ...(authorization
        ? { authorization: { resourceType: "agentic_app", launchAction: "use" } }
        : {}),
      surfaces: { showInHub: true },
      access: {
        tokenScopes: ["example:read"],
        policyActions: [{ action: "proxy:GET", defaultEffect: "allow" }],
      },
    },
    installation: {
      appId: id,
      packageId: id,
      installed: true,
      enabled: true,
      visible,
    },
  };
}

describe("configured External App CAS reconciliation", () => {
  it("grants visible authorized apps and revokes hidden ones", () => {
    const diff = buildConfiguredAgenticAppCasTupleDiff([
      configuredApp("visible-app", true),
      configuredApp("hidden-app", false),
      configuredApp("local-only-app", true, false),
    ]);

    expect(diff.writes).toEqual(
      expect.arrayContaining([
        {
          user: "user:*",
          relation: "user",
          object: "agentic_app:visible-app",
        },
      ]),
    );
    expect(diff.deletes).toEqual(
      expect.arrayContaining([
        {
          user: "user:*",
          relation: "user",
          object: "agentic_app:hidden-app",
        },
      ]),
    );
    expect([...diff.writes, ...diff.deletes]).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ object: "agentic_app:local-only-app" }),
      ]),
    );
  });
});
