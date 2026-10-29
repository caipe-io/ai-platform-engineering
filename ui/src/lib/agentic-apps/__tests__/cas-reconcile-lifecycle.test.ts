/** @jest-environment node */
import { reconcileConfiguredAgenticAppCasAccess } from "../cas-reconcile";
import { reconcileTupleDiff } from "@/lib/authz/reconcile";
import { readOpenFgaTuples } from "@/lib/rbac/openfga";
import { organizationObjectId } from "@/lib/rbac/organization";
import type { ConfiguredAgenticApp } from "@/types/agentic-app";

jest.mock("@/lib/agentic-apps/config", () => ({ isAgenticAppsEnabled: () => true }));
jest.mock("@/lib/authz/reconcile", () => ({ reconcileTupleDiff: jest.fn() }));
jest.mock("@/lib/rbac/openfga", () => ({ readOpenFgaTuples: jest.fn() }));

it("retries after model installation, coalesces requests and cleans a removed installation", async () => {
  const app = {
    manifest: { authorization: { resourceType: "agentic_app", launchAction: "use" } },
    installation: { appId: "example", installed: true, enabled: true, visible: true },
  } as ConfiguredAgenticApp;
  const read = jest.mocked(readOpenFgaTuples);
  const write = jest.mocked(reconcileTupleDiff);
  read.mockResolvedValue({ tuples: [] });
  write.mockRejectedValueOnce(new Error("authorization model not installed"));
  await expect(reconcileConfiguredAgenticAppCasAccess([app])).rejects.toThrow("model not installed");
  write.mockResolvedValue({ enabled: true, writes: 3, deletes: 0 });
  await Promise.all([reconcileConfiguredAgenticAppCasAccess([app]), reconcileConfiguredAgenticAppCasAccess([app])]);
  expect(write).toHaveBeenCalledTimes(2);
  read.mockResolvedValue({ tuples: [{ key: {
    user: organizationObjectId(), relation: "catalog_managed", object: "agentic_app:example",
  } }] });
  await reconcileConfiguredAgenticAppCasAccess([]);
  expect(write).toHaveBeenLastCalledWith({ writes: [], deletes: expect.arrayContaining([
    { user: "user:*", relation: "user", object: "agentic_app:example" },
  ]) }, expect.any(Object));
});
