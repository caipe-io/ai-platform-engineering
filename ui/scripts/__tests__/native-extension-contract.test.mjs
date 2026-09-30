import assert from "node:assert/strict";
import { test } from "node:test";
import { validateManifest, validateOwnership } from "../native-extension-contract.mjs";

const example = {
  id: "example-app",
  displayName: "Example App",
  description: "Example",
  contractVersion: "1.1",
  hostPaths: ["/example"],
  navigation: { label: "Example", href: "/example", placement: "after-chat" },
  api: { appId: "example-app", basePath: "/api/agentic-apps/runtime/example-app", mounts: ["/api/example"] },
  auth: { mode: "app-scoped-token" },
};

test("accepts a routeful advertised app", () => {
  assert.equal(validateManifest("example", example).id, "example-app");
});

test("accepts an internal route without navigation", () => {
  const internal = { ...example, navigation: undefined };
  assert.equal(validateManifest("internal", internal).id, "example-app");
});

test("accepts a route-less app in a declared slot", () => {
  const internal = { ...example, navigation: undefined };
  assert.equal(validateManifest("slot", { ...internal, hostPaths: [], slots: ["home"] }).id, "example-app");
});

test("rejects missing surface, unsafe paths, and undeclared auth", () => {
  assert.throws(() => validateManifest("empty", { ...example, hostPaths: [], navigation: undefined }), /path or slot/);
  assert.throws(() => validateManifest("unsafe", { ...example, hostPaths: ["//evil"] }), /host path/);
  assert.throws(() => validateManifest("auth", { ...example, auth: undefined }), /auth.mode/);
  assert.throws(() => validateManifest("nav", { ...example, navigation: { ...example.navigation, href: "/chat" } }), /navigation/);
});

test("rejects overlapping host paths and slots", () => {
  assert.throws(() => validateOwnership([
    { moduleName: "a", manifest: example },
    { moduleName: "b", manifest: { ...example, id: "other", hostPaths: ["/example/detail"], api: { ...example.api, mounts: ["/api/other"] } } },
  ]), /overlap/);
  assert.throws(() => validateOwnership([
    { moduleName: "a", manifest: { ...example, slots: ["home"] } },
    { moduleName: "b", manifest: { ...example, id: "other", slots: ["home"], hostPaths: ["/other"], api: { ...example.api, mounts: ["/api/other"] } } },
  ]), /overlap/);
});
