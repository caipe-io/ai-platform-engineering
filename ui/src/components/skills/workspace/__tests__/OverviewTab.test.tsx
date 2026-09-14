/**
 * OverviewTab — Sharing / team-picker regression coverage.
 *
 * Regression (2026-06-04): generic members reported they "can't pick teams"
 * in the Skill Builder. The Overview tab used to render a dead-end hint
 * ("use the Sharing dialog from the gallery") with no actual picker. It now
 * renders a real {@link TeamMultiPicker} fed by the app-wide member-accessible
 * "teams available for sharing" endpoint (`GET /api/dynamic-agents/teams`),
 * the same source the RAG KB / MCP / Dynamic-Agent editors use.
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";

import { OverviewTab } from "@/components/skills/workspace/tabs/OverviewTab";
import type { UseSkillFormResult } from "@/components/skills/workspace/use-skill-form";
import type { SkillVisibility } from "@/types/agent-skill";

// AiAssistButton pulls in providers / network we don't care about here.
jest.mock("@/components/ai-assist", () => ({
  AiAssistButton: () => <button type="button">AI</button>,
}));

function makeForm(
  overrides: Partial<UseSkillFormResult> = {},
): UseSkillFormResult {
  return {
    isEditMode: false,
    formData: {
      name: "",
      description: "",
      category: "Custom",
      difficulty: "beginner",
      thumbnail: "",
    },
    setFormData: jest.fn(),
    tags: [],
    setTags: jest.fn(),
    visibility: "private" as SkillVisibility,
    setVisibility: jest.fn(),
    selectedTeamIds: [],
    setSelectedTeamIds: jest.fn(),
    errors: {},
    ...overrides,
  } as unknown as UseSkillFormResult;
}

describe("OverviewTab sharing", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it("does NOT fetch teams while visibility is private", () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<OverviewTab form={makeForm({ visibility: "private" })} />);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      screen.queryByLabelText("Share skill with teams"),
    ).not.toBeInTheDocument();
  });

  it("renders a real team picker fed by /api/dynamic-agents/teams when sharing with a team", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      json: async () => ({
        success: true,
        data: [
          { slug: "platform", name: "Platform Team", _id: "1" },
          { slug: "sre", name: "SRE", _id: "2" },
        ],
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<OverviewTab form={makeForm({ visibility: "team" })} />);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/dynamic-agents/teams"),
    );

    expect(
      screen.getByLabelText("Share skill with teams"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Sharing dialog from the gallery/i),
    ).not.toBeInTheDocument();
  });

  it("shows the validation error when team visibility has no teams picked", () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ json: async () => ({ success: true, data: [] }) }) as unknown as typeof fetch;

    render(
      <OverviewTab
        form={makeForm({
          visibility: "team",
          errors: { teams: "Select at least one team to share with" },
        })}
      />,
    );

    expect(
      screen.getByText("Select at least one team to share with"),
    ).toBeInTheDocument();
  });
});
