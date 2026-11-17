import { validateAgenticAppManifest } from "../../../../app-sdk/agentic-app-manifest.mjs";
import {
  MAX_MESSAGE_ACTIONS,
  MAX_MESSAGE_ACTION_LABEL,
  MAX_MESSAGE_ACTION_TEXT,
  validateAssistantOptions,
} from "../../../../app-sdk/assistant-options.mjs";
import example from "../../../../examples/agentic-apps/shared/manifest.json";

const action = {
  id: "flag-answer",
  label: "Flag answer",
  icon: "flag",
  path: "/api/example/actions/flag",
  dialog: {
    title: "Flag this answer",
    description: "Edit the text to give a corrected answer.",
    submitLabel: "Submit",
    field: { label: "Corrected answer", prefill: "message", optional: true, maxLength: 60000 },
  },
};

type ManifestFixture = { ui: { assistant?: unknown }; access: { policyActions: unknown[] } };

function manifestWith(messageActions: unknown, assistant: Record<string, unknown> = {}) {
  const manifest = JSON.parse(JSON.stringify(example)) as ManifestFixture;
  manifest.ui.assistant = {
    agentId: "example-agent", label: "Ask", name: "Example", streamPath: "/api/example/chat",
    hostOptions: { version: "1.0", messageActions },
    ...assistant,
  };
  manifest.access.policyActions.push({ action: "proxy:POST", defaultEffect: "allow", requiredScopes: [] });
  return manifest;
}

describe("message action declarations", () => {
  it("accepts valid declarations with and without a dialog", () => {
    expect(() => validateAssistantOptions({ version: "1.0", messageActions: [action, { ...action, id: "mark", dialog: undefined }] })).not.toThrow();
    expect(() => validateAssistantOptions({ version: "1.0", messageActions: [] })).not.toThrow();
  });

  it.each([
    ["unknown key", [{ ...action, handler: "x" }]],
    ["duplicate ids", [action, action]],
    ["more than the limit", Array.from({ length: MAX_MESSAGE_ACTIONS + 1 }, (_, i) => ({ ...action, id: `action-${i}` }))],
    ["bad id", [{ ...action, id: "Bad Id" }]],
    ["blank label", [{ ...action, label: " " }]],
    ["oversize label", [{ ...action, label: "x".repeat(MAX_MESSAGE_ACTION_LABEL + 1) }]],
    ["unknown icon", [{ ...action, icon: "rocket" }]],
    ["missing path", [{ ...action, path: undefined }]],
    ["bad prefill", [{ ...action, dialog: { ...action.dialog, field: { ...action.dialog.field, prefill: "user" } } }]],
    ["non-boolean optional", [{ ...action, dialog: { ...action.dialog, field: { ...action.dialog.field, optional: "yes" } } }]],
    ["zero maxLength", [{ ...action, dialog: { ...action.dialog, field: { ...action.dialog.field, maxLength: 0 } } }]],
    ["oversize maxLength", [{ ...action, dialog: { ...action.dialog, field: { ...action.dialog.field, maxLength: MAX_MESSAGE_ACTION_TEXT + 1 } } }]],
    ["dialog unknown key", [{ ...action, dialog: { ...action.dialog, html: "<b>x</b>" } }]],
    ["not an array", { 0: action }],
  ])("rejects %s", (_name, messageActions) => {
    expect(() => validateAssistantOptions({ version: "1.0", messageActions })).toThrow();
  });
});

describe("message actions in a manifest", () => {
  it("accepts an action whose path has an allowed POST policy", () => {
    expect(() => validateAgenticAppManifest(manifestWith([action]))).not.toThrow();
  });

  it.each([
    ["a path outside the API namespace", { ...action, path: "/example/actions/flag" }],
    ["an unsafe path", { ...action, path: "/api/example/../flag" }],
    ["a path with a query", { ...action, path: "/api/example/flag?x=1" }],
  ])("rejects %s", (_name, bad) => {
    expect(() => validateAgenticAppManifest(manifestWith([bad]))).toThrow();
  });

  it("rejects actions on an app-owned overlay", () => {
    expect(() => validateAgenticAppManifest(manifestWith([action], { overlay: "app" }))).toThrow(/host overlay/);
  });

  it("rejects actions without an assistant stream", () => {
    expect(() => validateAgenticAppManifest(manifestWith([action], { streamPath: undefined }))).toThrow();
  });
});
