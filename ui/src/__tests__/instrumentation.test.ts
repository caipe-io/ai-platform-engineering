/** @jest-environment node */

import { register } from "../instrumentation";

const mockApplySeedConfig = jest.fn();
const mockStartRagReconciler = jest.fn();
const mockStartIdpScheduler = jest.fn();
const mockStartConversationRetention = jest.fn();

jest.mock("@/lib/seed-config", () => ({ applySeedConfig: (...args: unknown[]) => mockApplySeedConfig(...args) }));
jest.mock("@/lib/config-driven-rag-sources.server", () => ({
  startConfigDrivenRagSourceReconciler: (...args: unknown[]) => mockStartRagReconciler(...args),
}));
jest.mock("@/lib/rbac/idp-sync-scheduler", () => ({
  startIdpSyncScheduler: (...args: unknown[]) => mockStartIdpScheduler(...args),
}));
jest.mock("@/lib/conversation-retention.server", () => ({
  startConversationRetention: (...args: unknown[]) => mockStartConversationRetention(...args),
}));

const originalRuntime = process.env.NEXT_RUNTIME;
const originalAppsEnabled = process.env.AGENTIC_APPS_INSTALL_ENABLED;

beforeEach(() => {
  jest.clearAllMocks();
  mockApplySeedConfig.mockResolvedValue(undefined);
  process.env.NEXT_RUNTIME = "nodejs";
  delete process.env.AGENTIC_APPS_INSTALL_ENABLED;
});

afterEach(() => {
  if (originalRuntime === undefined) delete process.env.NEXT_RUNTIME;
  else process.env.NEXT_RUNTIME = originalRuntime;
  if (originalAppsEnabled === undefined) delete process.env.AGENTIC_APPS_INSTALL_ENABLED;
  else process.env.AGENTIC_APPS_INSTALL_ENABLED = originalAppsEnabled;
});

it("starts conversation retention from server startup without waiting for a user request", async () => {
  await register();

  expect(mockApplySeedConfig).toHaveBeenCalledTimes(1);
  expect(mockStartRagReconciler).toHaveBeenCalledTimes(1);
  expect(mockStartIdpScheduler).toHaveBeenCalledTimes(1);
  expect(mockStartConversationRetention).toHaveBeenCalledTimes(1);
});

it("waits for the existing bootstrap before starting retention", async () => {
  let finishSeed!: () => void;
  let enteredSeed!: () => void;
  const entered = new Promise<void>(resolve => { enteredSeed = resolve; });
  const pendingSeed = new Promise<void>(resolve => { finishSeed = resolve; });
  mockApplySeedConfig.mockImplementationOnce(async () => { enteredSeed(); await pendingSeed; });
  const startup = register();
  try {
    await entered;
    expect(mockStartConversationRetention).not.toHaveBeenCalled();
  } finally {
    finishSeed();
    await startup;
  }
  expect(mockStartConversationRetention).toHaveBeenCalledTimes(1);
});

it("does not start Node maintenance workers in the edge runtime", async () => {
  process.env.NEXT_RUNTIME = "edge";
  await register();

  expect(mockApplySeedConfig).not.toHaveBeenCalled();
  expect(mockStartConversationRetention).not.toHaveBeenCalled();
});
