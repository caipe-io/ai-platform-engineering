/** @jest-environment node */
import { projectAgentAppIdentity } from "../agent-catalog";
import { loadConfiguredAgenticApps } from "../config";
import { buildPublicAgenticApp } from "../public-app";
import type { ConfiguredAgenticApp } from "@/types/agentic-app";
import type { DynamicAgentConfig } from "@/types/dynamic-agent";
import example from "../../../../examples/agentic-apps/shared/manifest.json";

jest.mock("../config", () => ({ loadConfiguredAgenticApps: jest.fn() }));
jest.mock("@/lib/api-middleware", () => ({ ApiError: class extends Error {
  constructor(message: string, public statusCode: number) { super(message); }
} }));

const agent = { _id: "bound-agent", name: "Assistant" } as DynamicAgentConfig;
const user = { sub: "test-user", role: "user" };
let app: ConfiguredAgenticApp;

beforeEach(() => {
  app = { manifest: { ...example, access: { ...example.access, requiredRoles: ["user"] }, catalog: { icon: "/app-icons/example-app/logo.png" },
    ui: { ...example.ui, assistant: { agentId: "bound-agent", label: "Ask", name: "Assistant", streamPath: "/api/example/chat" } } },
    installation: { appId: "example-app", packageId: "example-app", installed: true, enabled: true, visible: true } } as ConfiguredAgenticApp;
  jest.mocked(loadConfiguredAgenticApps).mockReturnValue([app]);
});

it("projects only public identity from the resolved installation, without mutating the document", () => {
  const [result] = projectAgentAppIdentity([agent], user);
  expect(result.presentation).toEqual({ app: { id: "example-app", name: "Example App", icon: "/app-icons/example-app/logo.png" }, available: true });
  expect(agent).not.toHaveProperty("presentation");
  expect(buildPublicAgenticApp(app, true).icon).toBe("/app-icons/example-app/logo.png");
  expect(result.presentation).not.toHaveProperty("runtimeOrigin");
});

it("discards persisted presentation and preserves legacy native fallback", () => {
  const forged = { ...agent, _id: "native-agent", presentation: { app: { id: "forged", name: "Forged" }, available: true } };
  expect(projectAgentAppIdentity([forged], user)[0]).not.toHaveProperty("presentation");
});

it.each(["disabled", "uninstalled"])("keeps %s apps identifiable in details and excludes them from chat choices", state => {
  app.installation[state === "disabled" ? "enabled" : "installed"] = false;
  expect(projectAgentAppIdentity([agent], user)[0].presentation).toMatchObject({ app: { id: "example-app" }, available: false });
  expect(projectAgentAppIdentity([agent], user, { availableOnly: true })).toEqual([]);
});

it("requires app launch roles in addition to the prior agent CAS check", () => {
  app.manifest.access.requiredRoles = ["admin"];
  expect(projectAgentAppIdentity([agent], user)).toEqual([]);
  expect(projectAgentAppIdentity([agent], { ...user, role: "admin" })).toHaveLength(1);
});

it("does not offer an interactive app stream to a service account", () => {
  expect(projectAgentAppIdentity([agent], { ...user, isServiceAccount: true }, { availableOnly: true })).toEqual([]);
});

it("fails closed on ambiguous ownership and invalid configuration", () => {
  jest.mocked(loadConfiguredAgenticApps).mockReturnValue([app, app]);
  expect(() => projectAgentAppIdentity([agent], user)).toThrow("Ambiguous");
  jest.mocked(loadConfiguredAgenticApps).mockImplementation(() => { throw new Error("invalid config"); });
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  expect(() => projectAgentAppIdentity([agent], user)).toThrow("configuration unavailable");
  log.mockRestore();
});

it("offers native bot agents only when the app declares Webex support", () => {
  const session = { ...user, authMethod: "bearer", authorizedParty: "caipe-webex-bot" };
  expect(projectAgentAppIdentity([agent], session, { availableOnly: true })).toEqual([]);
  app.manifest.ui.assistant!.supportedClients = ["webui", "webex"];
  expect(projectAgentAppIdentity([agent], session, { availableOnly: true })).toHaveLength(1);
  expect(projectAgentAppIdentity([agent], { ...session, isServiceAccount: true }, { availableOnly: true })).toEqual([]);
});
