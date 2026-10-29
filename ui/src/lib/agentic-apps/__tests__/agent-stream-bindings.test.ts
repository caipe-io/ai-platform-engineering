/** @jest-environment node */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import example from "../../../../examples/agentic-apps/shared/manifest.json";
import { getAgenticAppAgentStreams, isAgenticAppBrowserContextPath, loadConfiguredAgenticApps } from "../config";
import { buildPublicAgenticApp } from "../public-app";

jest.mock("@/native-extensions/manifests.generated", () => ({ installedAgenticAppManifests: [], installedLegacyNativeExtensionIds: [] }));
const stream = { id: "secondary", agentId: "team/secondary-agent", streamPath: "/api/example/secondary/start",
  resumePath: "/api/example/secondary/resume", cancelPath: "/api/example/secondary/cancel", statusPath: "/api/example/secondary/status" };
const manifest = { ...example, access: { ...example.access, policyActions: [
  ...example.access.policyActions, { action: "proxy:POST", defaultEffect: "allow" },
] }, ui: { ...example.ui, assistant: { agentId: "primary-agent", label: "Ask", name: "Primary",
  streamPath: "/api/example/primary/start", supportedClients: ["webui", "webex"], webexGroupChat: true } } };
const previousEnabled = process.env.AGENTIC_APPS_INSTALL_ENABLED;
beforeEach(() => { process.env.AGENTIC_APPS_INSTALL_ENABLED = "true"; });
afterAll(() => { if (previousEnabled === undefined) delete process.env.AGENTIC_APPS_INSTALL_ENABLED;
  else process.env.AGENTIC_APPS_INSTALL_ENABLED = previousEnabled; });

function load(bindings: Record<string, unknown>, source: unknown = manifest, extra: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "agent-streams-"));
  const path = join(directory, "apps.json");
  try {
    writeFileSync(path, JSON.stringify({ agentic_apps: { packages: [{ package_id: "example-app", manifest: source }],
      installations: [{ app_id: "example-app", selected_ui_profile: "hosted", bindings: { runtimeOrigin: "https://runtime.example.test", ...bindings } }], ...extra } }));
    return loadConfiguredAgenticApps(path);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

it("normalizes the primary and registered agents without inheriting primary Webex support", () => {
  const [app] = load({ agentStreams: [stream] });
  expect(getAgenticAppAgentStreams(app)).toEqual([
    expect.objectContaining({ id: "assistant", agentId: "primary-agent", supportedClients: ["webui", "webex"], webexGroupChat: true }), stream,
  ]);
  const catalog = buildPublicAgenticApp(app, true);
  expect(catalog.chatAgentIds).toEqual(["primary-agent", "team/secondary-agent"]);
  expect(catalog.assistantUsesAppRuntime).toBe(true);
  expect(JSON.stringify(catalog)).not.toContain("runtime.example.test");
  expect(JSON.stringify(catalog)).not.toContain("/api/example");
});

it("preserves the canonical deployment binding and explicit per-agent clients", () => {
  const [app] = load({ resources: { assistant: "team/primary-agent" },
    agentStreams: [{ ...stream, supportedClients: ["webex"], webexGroupChat: false }] });
  expect(getAgenticAppAgentStreams(app)[0].agentId).toBe("team/primary-agent");
  expect(getAgenticAppAgentStreams(app)[1]).toMatchObject({ supportedClients: ["webex"], webexGroupChat: false });
  expect(buildPublicAgenticApp(app, true).chatAgentIds).toEqual(["team/primary-agent"]);
});

it("does not advertise a Webex-only primary or additional stream as a browser assistant", () => {
  const [app] = load({ agentStreams: [{ ...stream, supportedClients: ["webex"] }] }, {
    ...manifest, ui: { ...manifest.ui, assistant: { ...manifest.ui.assistant, supportedClients: ["webex"] } },
  });
  expect(buildPublicAgenticApp(app, true)).toMatchObject({ assistantEnabled: false, chatAgentIds: [] });
});

it.each([
  ["reserved identity", [{ ...stream, id: "assistant" }]],
  ["duplicate binding", [stream, stream]],
  ["duplicate agent", [stream, { ...stream, id: "third" }]],
  ["primary agent", [{ ...stream, agentId: "primary-agent" }]],
  ["invalid identity", [{ ...stream, agentId: "agent with spaces" }]],
  ["unbounded agents", Array.from({ length: 21 }, (_, index) => ({ ...stream, id: `agent-${index}`, agentId: `agent-${index}` }))],
  ["unknown field", [{ ...stream, runtimeOrigin: "https://other.example.test" }]],
  ["missing stream", [{ id: "secondary", agentId: "secondary-agent" }]],
  ["unpublished path", [{ ...stream, streamPath: "/api/other/start" }]],
  ["traversal", [{ ...stream, resumePath: "/api/example/../admin" }]],
  ["encoded separator", [{ ...stream, cancelPath: "/api/example/%2fadmin" }]],
  ["query", [{ ...stream, statusPath: "/api/example/status?admin=1" }]],
  ["repeated clients", [{ ...stream, supportedClients: ["webui", "webui"] }]],
  ["unsupported client", [{ ...stream, supportedClients: ["unknown"] }]],
  ["empty clients", [{ ...stream, supportedClients: [] }]],
  ["implicit group support", [{ ...stream, webexGroupChat: true }]],
  ["invalid group support", [{ ...stream, supportedClients: ["webex"], webexGroupChat: "true" }]],
])("rejects %s before any dispatch", (_name, streams) => {
  expect(() => load({ agentStreams: streams })).toThrow();
});

it("requires an explicitly allowed publisher POST policy for every operation", () => {
  expect(() => load({ agentStreams: [stream] }, { ...manifest, access: example.access })).toThrow(/allowed POST policy/);
});

it("does not admit an agent stream without a runtime", () => {
  const source = { ...example, ui: example.ui,
    access: manifest.access, runtime: undefined };
  expect(() => load({ agentStreams: [stream] }, source)).toThrow(/runtime/);
});

it("admits only exact operator-owned browser proof paths", () => {
  const [app] = load({}, manifest, { gateway_policies: { "example-app": { browserContextPaths: ["/api/example/secondary/start"] } } });
  expect(isAgenticAppBrowserContextPath(app, ["api", "example", "secondary", "start"])).toBe(true);
  for (const segments of [["api", "example", "secondary", "start", "child"], ["api", "example/secondary", "start"],
    ["api", "example", "secondary", "%73tart"], ["api", "example", "..", "start"]]) {
    expect(isAgenticAppBrowserContextPath(app, segments)).toBe(false);
  }
  expect(isAgenticAppBrowserContextPath(load({})[0], ["api", "example", "secondary", "start"])).toBe(false);
  expect(buildPublicAgenticApp(app, true)).not.toHaveProperty("gatewayPolicy");
});

it.each(["/*", "/api/example/*", "/api/example/../admin", "/api/example//start", "/api/example/start/", "/api/example/%2fstart"])
  ("rejects noncanonical browser proof policy %s", (path) => {
    expect(() => load({}, manifest, { gateway_policies: { "example-app": { browserContextPaths: [path] } } })).toThrow(/canonical API route patterns/);
  });
it("rejects browser proof policy for an absent app", () => {
  expect(() => load({}, manifest, { gateway_policies: { missing: { browserContextPaths: [] } } })).toThrow(/absent installation/);
});

it("admits bounded project route templates without enumerating projects", () => {
  const [app] = load({}, manifest, { gateway_policies: { "example-app": { browserContextPaths: ["/api/projects/:projectId/research"] } } });
  expect(isAgenticAppBrowserContextPath(app, ["api", "projects", "new-project", "research"])).toBe(true);
});
it.each(["/api/:/research", "/api/:project*/research", "/api/:project.id/research", "/api/projects/**", "/api/projects/:id?"])
  ("rejects unbounded or malformed route template %s", path => {
    expect(() => load({}, manifest, { gateway_policies: { "example-app": { browserContextPaths: [path] } } })).toThrow(/canonical API route patterns/);
  });
