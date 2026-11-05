import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateAgenticAppManifest } from "../../app-sdk/agentic-app-manifest.mjs";

test("route capabilities require the explicit application CAS declaration", () => {
  const app = JSON.parse(readFileSync(new URL("../../examples/agentic-apps/shared/manifest.json", import.meta.url)));
  app.access.policyActions[0].casAction = "read";
  assert.throws(() => validateAgenticAppManifest(app), /casAction requires/);
  app.authorization = { resourceType: "agentic_app", launchAction: "use" };
  assert.doesNotThrow(() => validateAgenticAppManifest(app));
  app.access.policyActions[0].casAction = "unknown";
  assert.throws(() => validateAgenticAppManifest(app), /casAction requires/);
});
