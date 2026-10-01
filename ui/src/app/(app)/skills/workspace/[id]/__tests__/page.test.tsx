import { render,screen,waitFor } from "@testing-library/react";

import type { AgentSkill } from "@/types/agent-skill";

import SkillWorkspacePage from "../page";

const mockLoadSkills = jest.fn();
const mockGetSkillById = jest.fn();
let mockConfigs: AgentSkill[] = [];
let mockIsLoading = false;

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock("@/components/auth-guard", () => ({
  AuthGuard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock("@/components/ui/caipe-spinner", () => ({
  CAIPESpinner: () => <div>Loading</div>,
}));

jest.mock("@/store/agent-skills-store", () => ({
  useAgentSkillsStore: () => ({
    configs: mockConfigs,
    isLoading: mockIsLoading,
    loadSkills: mockLoadSkills,
    getSkillById: mockGetSkillById,
  }),
}));

jest.mock("@/components/skills/workspace/SkillWorkspace", () => ({
  SkillWorkspace: ({
    existingConfig,
    readOnly,
  }: {
    existingConfig?: AgentSkill;
    readOnly?: boolean;
  }) => (
    <div
      data-testid="skill-workspace"
      data-skill-id={existingConfig?.id}
      data-owner-id={existingConfig?.owner_id}
      data-read-only={String(Boolean(readOnly))}
      data-ancillary={JSON.stringify(existingConfig?.ancillary_files ?? {})}
    />
  ),
}));

function fulfilledParams(id: string): Promise<{ id: string }> {
  const params = Promise.resolve({ id }) as Promise<{ id: string }> & {
    status: "fulfilled";
    value: { id: string };
  };
  params.status = "fulfilled";
  params.value = { id };
  return params;
}

describe("SkillWorkspacePage catalog fallback", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConfigs = [];
    mockIsLoading = false;
    mockGetSkillById.mockReturnValue(undefined);
  });

  it("loads an imported Mongo skill when the visible config store is empty", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        skills: [
          {
            id: "skill-imported-123",
            name: "Imported skill",
            description: "",
            source: "agent_skills",
            source_id: "skill-imported-123",
            owner_id: "alice@example.com",
            content: "# Imported skill",
            ancillary_files: { "scripts/run.sh": "echo ok" },
            metadata: { category: "imported", is_system: false },
          },
        ],
      }),
    }) as jest.Mock;

    render(
      <SkillWorkspacePage params={fulfilledParams("skill-imported-123")} />,
    );

    const workspace = await screen.findByTestId("skill-workspace");
    expect(workspace).toHaveAttribute("data-skill-id", "skill-imported-123");
    expect(workspace).toHaveAttribute("data-owner-id", "alice@example.com");
    expect(workspace).toHaveAttribute("data-read-only", "false");
    expect(workspace).toHaveAttribute(
      "data-ancillary",
      JSON.stringify({ "scripts/run.sh": "echo ok" }),
    );
    await waitFor(() => expect(mockLoadSkills).toHaveBeenCalled());
  });

  it("keeps default catalog skills read-only", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        skills: [
          {
            id: "builtin-one",
            name: "Built in",
            source: "default",
            source_id: "builtin-one",
            content: "# Built in",
            metadata: { is_system: true },
          },
        ],
      }),
    }) as jest.Mock;

    render(
      <SkillWorkspacePage params={fulfilledParams("catalog-builtin-one")} />,
    );

    const workspace = await screen.findByTestId("skill-workspace");
    expect(workspace).toHaveAttribute("data-skill-id", "catalog-builtin-one");
    expect(workspace).toHaveAttribute("data-read-only", "true");
  });
});
