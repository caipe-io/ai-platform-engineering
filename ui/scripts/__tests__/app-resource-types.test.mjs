import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateAgenticAppManifest } from "../../app-sdk/agentic-app-manifest.mjs";
const app = JSON.parse(readFileSync(new URL("../../examples/agentic-apps/service-only/manifest.json", import.meta.url), "utf8"));
test("declares app resource types and actions independently of UI packages", () => {
  assert.deepEqual(validateAgenticAppManifest(app).resourceTypes, [{ name: "agent-sandbox", actions: ["execute", "terminate"] }]);
  const iframe = { ...app, ui: { profiles: [{ id: "hosted", mode: "iframe" }], routes: [] },
    runtime: { kind: "proxied-next-zone", mountPath: "/apps/example-service" },
    access: { ...app.access, policyActions: [{ action: "proxy:GET", defaultEffect: "allow" }] } };
  assert.equal(validateAgenticAppManifest(iframe).ui.profiles[0].mode, "iframe");
});
test("rejects ambiguous declarations, reserved ownership and policy source fields", () => {
  for (const resourceTypes of [
    [{ name: "agent-sandbox", actions: [] }],
    [{ name: "agent-sandbox", actions: ["execute", "execute"] }],
    [{ name: "agent-sandbox", actions: ["owner"] }],
    [{ name: "agent-sandbox", actions: ["grant:execute"] }],
    [{ name: "invalid:type", actions: ["execute"] }],
    [...app.resourceTypes, ...app.resourceTypes],
    [{ name: "agent-sandbox", actions: ["execute"], policy: "any" }],
  ]) assert.throws(() => validateAgenticAppManifest({ ...app, resourceTypes }));
  assert.throws(() => validateAgenticAppManifest({ ...app, authorization: { module: "example" } }), /unknown field/);
});
