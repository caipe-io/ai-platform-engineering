import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateAgenticAppManifest } from "../../app-sdk/agentic-app-manifest.mjs";

const fixture = JSON.parse(readFileSync(new URL("../../examples/agentic-apps/shared/manifest.json", import.meta.url)));
function manifest(policies) {
  const app = structuredClone(fixture);
  app.ui.assistant = { agentId: "example-agent", label: "Example", name: "Example", streamPath: "/api/stream" };
  app.access.policyActions = policies;
  return app;
}
test("stream policy uses runtime path and method matching", () => {
  for (const policy of [
    { action: "stream", method: "POST", path: "/api/stream", defaultEffect: "allow" },
    { action: "stream", method: "POST", path: "/api/:action", defaultEffect: "allow" },
    { action: "proxy:POST", defaultEffect: "allow" },
  ]) assert.doesNotThrow(() => validateAgenticAppManifest(manifest([policy])));
});
test("unrelated, denied and shadowed stream policies fail publication", () => {
  const deny = { action: "deny", method: "POST", path: "/api/:action", defaultEffect: "deny" };
  const allow = { action: "allow", method: "POST", path: "/api/stream", defaultEffect: "allow" };
  for (const policies of [
    [{ ...allow, path: "/api/other" }],
    [{ action: "proxy:GET", defaultEffect: "allow" }],
    [deny, allow],
    [{ ...allow, path: "/api/other" }, { action: "proxy:POST", defaultEffect: "allow" }],
  ]) assert.throws(() => validateAgenticAppManifest(manifest(policies)), /allowed POST policy/);
});

test("native bot clients are explicit and group support requires Webex", () => {
  const make = assistant => {
    const app = manifest([{ action: "proxy:POST", defaultEffect: "allow" }]);
    Object.assign(app.ui.assistant, assistant);
    return app;
  };
  assert.doesNotThrow(() => validateAgenticAppManifest(make({ supportedClients: ["webui", "webex"], webexGroupChat: false })));
  for (const assistant of [
    { supportedClients: [] }, { supportedClients: ["unknown"] }, { supportedClients: ["webex", "webex"] },
    { supportedClients: ["webui"], webexGroupChat: true }, { webexGroupChat: "true" },
  ]) assert.throws(() => validateAgenticAppManifest(make(assistant)), /supportedClients|webexGroupChat/);
});
