/** @jest-environment node */
import JSZip from "jszip";
import { NextRequest } from "next/server";
import type { AgentSkill } from "@/types/agent-skill";
import type { ShareableResourceInput } from "@/lib/rbac/openfga-owned-resources";

let mockStored: AgentSkill | null;
let mockLeaseOwner: string | undefined;
let mockOnLeaseBlocked: () => void;
const mockGrants = new Set<string>();
const mockReadTeamShares = jest.fn();
const mockScan = jest.fn();
const mockSyncSkillResource = jest.fn();
const mockSkills = {
  findOne: jest.fn(async () => mockStored ? { ...mockStored } : null),
  find: jest.fn(() => ({ toArray: async () => mockStored ? [mockStored] : [] })),
  insertOne: jest.fn(async (document) => { mockStored = document; }),
  replaceOne: jest.fn(async (_filter, document) => { mockStored = document; }),
  updateOne: jest.fn(async (filter, update) => {
    if (!mockStored || (filter.config_driven?.$ne === true && mockStored.config_driven)) return { matchedCount: 0 };
    mockStored = { ...mockStored, ...update.$set };
    return { matchedCount: 1 };
  }),
  deleteOne: jest.fn(async (filter) => {
    if (!mockStored || (filter.config_driven?.$ne === true && mockStored.config_driven)) return { deletedCount: 0 };
    mockStored = null;
    return { deletedCount: 1 };
  }),
};
const mockState = {
  updateOne: jest.fn(async (filter, update, options) => {
    if (options?.upsert) {
      if (mockLeaseOwner) {
        mockOnLeaseBlocked();
        throw { code: 11000 };
      }
      mockLeaseOwner = update.$set.lease_owner;
    } else if (filter.lease_owner !== mockLeaseOwner) return { matchedCount: 0 };
    if (update.$unset) mockLeaseOwner = undefined;
    return { matchedCount: 1 };
  }),
};
jest.mock("@/lib/mongodb", () => ({
  isMongoDBConfigured: true,
  getCollection: async (name: string) => name === "startup_seeds" ? mockState : name === "agent_skills" ? mockSkills : {
    find: () => ({ project: () => ({ toArray: async () => [] }) }),
  },
}));
jest.mock("@/lib/api-middleware", () => ({
  ApiError: class extends Error { constructor(message: string, public statusCode: number) { super(message); } },
  successResponse: (data: unknown, status = 200) => Response.json({ data }, { status }),
  withAuth: async (request: NextRequest, action: (...args: unknown[]) => Promise<Response>) =>
    action(request, { email: "test-user@example.com" }, { sub: "test-user" }),
  withErrorHandler: (action: (request: NextRequest) => Promise<Response>) => async (request: NextRequest) => {
    try { return await action(request); }
    catch (error) { return Response.json({}, { status: (error as { statusCode?: number }).statusCode ?? 500 }); }
  },
}));
jest.mock("@/lib/agent-skill-visibility", () => ({ getAgentSkillVisibleToUser: async () => mockStored ? { ...mockStored } : null }));
jest.mock("@/lib/rbac/resource-authz", () => ({ requireSkillPermission: async () => {} }));
jest.mock("@/lib/rbac/keycloak-resource-sync", () => ({ syncSkillResource: (...args: unknown[]) => mockSyncSkillResource(...args) }));
jest.mock("@/lib/skill-revisions", () => ({ recordRevision: async () => {}, snapshotsDiffer: () => true, deleteRevisionsForSkill: async () => {} }));
jest.mock("@/lib/skill-scan", () => ({ scanSkillContent: (...args: unknown[]) => mockScan(...args) }));
jest.mock("@/lib/skill-scan-history", () => ({ recordScanEvent: async () => {} }));
jest.mock("@/lib/rbac/organization", () => ({ organizationObjectId: () => "organization:example", caipeOrgKey: () => "example" }));
jest.mock("@/lib/rbac/openfga-owned-resources-reconcile", () => ({
  reconcileShareableResource: async (input: ShareableResourceInput) => {
    const { buildShareableResourceTupleDiff } = jest.requireActual("@/lib/rbac/openfga-owned-resources");
    const diff = buildShareableResourceTupleDiff(input);
    for (const key of diff.deletes) mockGrants.delete(JSON.stringify(key));
    for (const key of diff.writes) mockGrants.add(JSON.stringify(key));
    return {};
  },
}));
jest.mock("@/lib/rbac/skill-team-grants", () => ({
  ...jest.requireActual("@/lib/rbac/skill-team-grants"),
  readSkillSharedTeamSlugsFromOpenFga: (...args: unknown[]) => mockReadTeamShares(...args),
}));
jest.mock("@/app/api/skills/skill-templates-loader", () => ({ resolveTemplateDir: () => null }));

import { seedConfiguredSkills } from "@/lib/seed-config";
import { withSkillConfigLease } from "@/lib/seed-skills";
import { reconcileSkillTeamShares } from "@/lib/rbac/skill-team-grants";
import { DELETE, POST, PUT } from "../route";
import { runZipImport } from "../import-zip/route";
import { persistImportedSkill } from "../import-zip/persist-skill";

const ordinary = {
  id: "example-skill", name: "Example Skill", owner_id: "original-owner@example.com",
  config_driven: false, visibility: "global", tasks: [], skill_content: "Original content",
} as AgentSkill;
const orgGrant = (id: string) => JSON.stringify({ user: "organization:example#member", relation: "user", object: `skill:${id}` });

function attemptAdoption(id = ordinary.id, name = ordinary.name) {
  const blocked = new Promise<void>((resolve) => { mockOnLeaseBlocked = resolve; });
  const adoption = seedConfiguredSkills([{ id, name, content: "Configured content" }]);
  return { adoption, attempted: Promise.race([adoption, blocked]) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockReadTeamShares.mockReset().mockResolvedValue([]);
  mockScan.mockReset().mockResolvedValue({ scan_status: "passed" });
  mockSyncSkillResource.mockReset().mockResolvedValue(undefined);
  mockOnLeaseBlocked = () => {};
  mockStored = { ...ordinary };
  mockLeaseOwner = undefined;
  mockGrants.clear();
  mockGrants.add(orgGrant(ordinary.id));
});

it("keeps an ordinary PUT's grant revocation before configuration adoption", async () => {
  let adoption!: Promise<number>;
  let adoptedDuringGrantUpdate = false;
  mockReadTeamShares.mockImplementation(async () => {
    const attempt = attemptAdoption();
    adoption = attempt.adoption;
    await attempt.attempted;
    adoptedDuringGrantUpdate = mockStored?.config_driven === true;
    return [];
  });
  const response = await PUT(new NextRequest("https://example.test/api/skills/configs?id=example-skill", {
    method: "PUT", body: JSON.stringify({ visibility: "private" }),
  }));
  await adoption;
  expect(response.status).toBe(200);
  expect(adoptedDuringGrantUpdate).toBe(false);
  expect(mockStored).toMatchObject({ config_driven: true, visibility: "global" });
  expect(mockGrants.has(orgGrant(ordinary.id))).toBe(true);
});

it("allows configuration adoption during scanning and rejects the pending ordinary save", async () => {
  let finishScan!: () => void;
  let scanStarted!: () => void;
  const started = new Promise<void>((resolve) => { scanStarted = resolve; });
  mockScan.mockImplementation(async () => {
    scanStarted();
    await new Promise<void>((resolve) => { finishScan = resolve; });
    return { scan_status: "passed" };
  });
  const pending = PUT(new NextRequest("https://example.test/api/skills/configs?id=example-skill", {
    method: "PUT", body: JSON.stringify({ skill_content: "Ordinary edit", visibility: "private" }),
  }));
  await started;
  await seedConfiguredSkills([{ id: ordinary.id, name: ordinary.name, content: "Configured content" }]);
  finishScan();
  expect((await pending).status).toBe(403);
  expect(mockStored).toMatchObject({ config_driven: true, skill_content: "Configured content", visibility: "global" });
  expect(mockGrants.has(orgGrant(ordinary.id))).toBe(true);
});

it("coordinates owner grant repair with configuration adoption before an ordinary edit", async () => {
  mockStored = { ...ordinary, owner_id: "test-user@example.com" };
  let adoption!: Promise<number>;
  let adoptedDuringOwnerRepair = false;
  mockReadTeamShares.mockImplementationOnce(async () => {
    const attempt = attemptAdoption();
    adoption = attempt.adoption;
    await attempt.attempted;
    adoptedDuringOwnerRepair = mockStored?.config_driven === true;
    return [];
  });
  const response = await PUT(new NextRequest("https://example.test/api/skills/configs?id=example-skill", {
    method: "PUT", body: JSON.stringify({ visibility: "private" }),
  }));
  await adoption;
  expect(response.status).toBe(200);
  expect(adoptedDuringOwnerRepair).toBe(false);
  expect(mockStored).toMatchObject({ config_driven: true, visibility: "global" });
  expect(mockGrants.has(orgGrant(ordinary.id))).toBe(true);
});

it("does not repair owner grants on a configured skill", async () => {
  mockStored = { ...ordinary, config_driven: true, owner_id: "test-user@example.com" };
  const response = await PUT(new NextRequest("https://example.test/api/skills/configs?id=example-skill", {
    method: "PUT", body: JSON.stringify({ visibility: "private" }),
  }));
  expect(response.status).toBe(403);
  expect(mockReadTeamShares).not.toHaveBeenCalled();
  expect(mockSkills.updateOne).not.toHaveBeenCalled();
  expect(mockGrants.has(orgGrant(ordinary.id))).toBe(true);
});

it.each(["create", "delete"] as const)("coordinates ordinary %s persistence and permissions with configuration adoption", async (operation) => {
  let adoption!: Promise<number>;
  let adoptedDuringGrantUpdate = false;
  mockSyncSkillResource.mockImplementation(async (_operation, id) => {
    const attempt = attemptAdoption(id);
    adoption = attempt.adoption;
    await attempt.attempted;
    adoptedDuringGrantUpdate = mockStored?.config_driven === true;
    if (operation === "delete") mockGrants.delete(orgGrant(id));
  });
  const response = operation === "delete"
    ? await DELETE(new NextRequest("https://example.test/api/skills/configs?id=example-skill", { method: "DELETE" }))
    : await POST(new NextRequest("https://example.test/api/skills/configs", {
      method: "POST", body: JSON.stringify({
        name: ordinary.name, category: "Custom", visibility: "private",
        tasks: [{ display_text: "Example", llm_prompt: "Say hello", subagent: "user_input" }],
      }),
    }));
  await adoption;
  expect(response.status).toBe(operation === "create" ? 201 : 200);
  expect(adoptedDuringGrantUpdate).toBe(false);
  expect(mockStored).toMatchObject({ config_driven: true, visibility: "global" });
  expect(mockGrants.has(orgGrant(mockStored!.id))).toBe(true);
});

it.each(["overwrite", "create"] as const)("coordinates ZIP %s persistence and access with configuration adoption", async (mode) => {
  const zip = new JSZip();
  zip.file("SKILL.md", "---\nname: Example Skill\ndescription: Example\n---\nImported content");
  const bytes = await zip.generateAsync({ type: "uint8array" });
  let adoption!: Promise<number>;
  let adoptedDuringGrantUpdate = false;
  const result = await runZipImport({
    buffer: bytes.buffer as ArrayBuffer,
    resolutions: mode === "overwrite" ? [{
      candidateId: "(root)", candidateName: ordinary.name, existingName: ordinary.name, existingId: ordinary.id, action: "overwrite",
    }] : [],
    user: { email: "test-user@example.com" },
    teamRefs: mode === "overwrite" ? ["example-team"] : [],
    loadVisibleSkills: async () => mode === "overwrite" ? [ordinary] : [],
    withWriteLease: withSkillConfigLease,
    persistSkill: (skill, operation) => persistImportedSkill(mockSkills as never, skill, operation),
    reconcileAccess: async (skill, _operation, previous) => {
      const attempt = attemptAdoption(skill.id, skill.name);
      adoption = attempt.adoption;
      await attempt.attempted;
      adoptedDuringGrantUpdate = mockStored?.config_driven === true;
      await reconcileSkillTeamShares({
        skillId: skill.id, ownerSubject: "test-user", previousTeamRefs: [], nextTeamRefs: [],
        nextVisibility: skill.visibility, previousVisibility: previous?.visibility ?? "private",
      });
    },
  });
  await adoption;
  expect(result.phase).toBe("import");
  if (result.phase === "import") expect(result.imported[0].outcome).toBe(mode === "create" ? "created" : "overwritten");
  expect(adoptedDuringGrantUpdate).toBe(false);
  expect(mockStored).toMatchObject({ config_driven: true, visibility: "global" });
  expect(mockGrants.has(orgGrant(mockStored!.id))).toBe(true);
});

it.each(["overwrite", "create"] as const)("holds the lease through ZIP %s rollback after access failure", async (mode) => {
  const zip = new JSZip();
  zip.file("SKILL.md", "---\nname: Example Skill\ndescription: Example\n---\nImported content");
  const bytes = await zip.generateAsync({ type: "uint8array" });
  let adoption!: Promise<number>;
  let adoptedDuringGrantUpdate = false;
  const result = await runZipImport({
    buffer: bytes.buffer as ArrayBuffer,
    resolutions: mode === "overwrite" ? [{
      candidateId: "(root)", candidateName: ordinary.name, existingName: ordinary.name, existingId: ordinary.id, action: "overwrite",
    }] : [],
    user: { email: "test-user@example.com" },
    loadVisibleSkills: async () => mode === "overwrite" ? [ordinary] : [],
    withWriteLease: withSkillConfigLease,
    persistSkill: (skill, operation) => persistImportedSkill(mockSkills as never, skill, operation),
    reconcileAccess: async (skill) => {
      const attempt = attemptAdoption(skill.id, skill.name);
      adoption = attempt.adoption;
      await attempt.attempted;
      adoptedDuringGrantUpdate = mockStored?.config_driven === true;
      throw new Error("Access service unavailable");
    },
  });
  await adoption;
  expect(result.phase).toBe("import");
  if (result.phase === "import") expect(result.imported[0]).toMatchObject({ outcome: "failed", error: "Access service unavailable" });
  expect(adoptedDuringGrantUpdate).toBe(false);
  if (mode === "create") expect(mockSkills.deleteOne).toHaveBeenCalledWith(expect.objectContaining({ config_driven: { $ne: true } }));
  else expect(mockSkills.replaceOne).toHaveBeenCalledWith(
    expect.objectContaining({ config_driven: { $ne: true } }), expect.objectContaining({ skill_content: ordinary.skill_content }),
  );
  expect(mockStored).toMatchObject({ config_driven: true, visibility: "global" });
  expect(mockGrants.has(orgGrant(mockStored!.id))).toBe(true);
});
