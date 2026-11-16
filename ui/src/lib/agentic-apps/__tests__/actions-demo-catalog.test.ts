/** @jest-environment node */
import { join } from "node:path";

import { validateAssistantConfiguration } from "../../../../app-sdk/assistant-options.mjs";
import { findAgenticAppMessageAction } from "../assistant-actions";
import { getAgenticAppRoutingSnapshot, loadConfiguredAgenticApps } from "../config";

jest.mock("../proxy", () => ({ proxyAgenticAppRequest: jest.fn() }));
jest.mock("@/lib/mongodb", () => ({ getCollection: jest.fn() }));
jest.mock("@/lib/audit", () => ({ getAuditBackend: () => ({ write: jest.fn() }) }));

const catalog = join(process.cwd(), "examples/external-apps/actions-demo/agentic-apps.yaml");
const previous = { enabled: process.env.AGENTIC_APPS_INSTALL_ENABLED, path: process.env.AGENTIC_APPS_CONFIG_PATH };

beforeAll(() => {
  process.env.AGENTIC_APPS_INSTALL_ENABLED = "true";
  process.env.AGENTIC_APPS_CONFIG_PATH = catalog;
});
afterAll(() => {
  for (const [key, value] of [["AGENTIC_APPS_INSTALL_ENABLED", previous.enabled], ["AGENTIC_APPS_CONFIG_PATH", previous.path]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

// The demo catalog is what the manual test installs, so it must stay valid.
describe("actions demo catalog", () => {
  it("loads through the host's catalog validation", () => {
    const apps = loadConfiguredAgenticApps(catalog);
    expect(apps.map((app) => app.installation.appId)).toEqual(["actions-demo"]);
  });

  it("resolves both declared actions to their app paths", () => {
    loadConfiguredAgenticApps(catalog);
    expect(findAgenticAppMessageAction("actions-demo-assistant", "flag-answer")).toMatchObject({
      appId: "actions-demo", path: ["api", "assistant", "actions", "flag"],
    });
    expect(findAgenticAppMessageAction("actions-demo-assistant", "mark")).toMatchObject({
      path: ["api", "assistant", "actions", "mark"],
    });
    expect(findAgenticAppMessageAction("actions-demo-assistant", "other")).toBeNull();
  });

  it("accepts the visibility the demo page sends", () => {
    loadConfiguredAgenticApps(catalog);
    const options = getAgenticAppRoutingSnapshot()[0].manifest.ui.assistant!.hostOptions!;
    expect(() => validateAssistantConfiguration({
      version: "1.0", visible: true, messageActions: { "flag-answer": { visible: true }, mark: { visible: false } },
    }, options)).not.toThrow();
  });
});
