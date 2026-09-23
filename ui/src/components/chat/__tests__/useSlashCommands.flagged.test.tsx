/**
 * Unit tests for the flagged-skill defense in ``useSlashCommands``.
 *
 * The hook fetches ``/api/skills`` (the unified catalog endpoint that
 * stamps ``runnable``/``blocked_reason``/``scan_status`` on every entry
 * via ``applyRunnableGate``) and assembles slash-command entries for the
 * chat autocomplete menu. Per security policy a flagged skill must never
 * appear as a selectable command. Offering it in the picker leaks
 * metadata to the user and gives the impression the command is
 * available. These tests pin the
 * three signals we treat as authoritative (mirrors the bash filters in
 * ``install.sh`` and the React filter in ``SkillsSelector.tsx``).
 */

import { renderHook, waitFor } from "@testing-library/react";

import { useSlashCommands } from "../useSlashCommands";

function mockSkillsResponse(skills: Array<Record<string, unknown>>) {
  global.fetch = jest.fn(async () => {
    return {
      ok: true,
      json: async () => ({ skills }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("useSlashCommands flagged-skill gate", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("chat view drops skills with scan_status=flagged", async () => {
    mockSkillsResponse([
      { id: "safe", name: "safe-skill", description: "Safe one", scan_status: "passed" },
      {
        id: "evil",
        name: "evil-skill",
        description: "Should be hidden",
        scan_status: "flagged",
        runnable: false,
        blocked_reason: "scan_flagged",
      },
    ]);

    const { result } = renderHook(() => useSlashCommands());

    await waitFor(() => {
      const labels = result.current.map((c) => c.label);
      expect(labels).toContain("safe-skill");
    });

    const labels = result.current.map((c) => c.label);
    expect(labels).not.toContain("evil-skill");
  });

  it("chat view drops skills marked runnable=false even without scan_status", async () => {
    // ``runnable=false`` alone (e.g. unscanned-strict gate without an
    // explicit ``flagged`` stamp) must still be hidden so older
    // gateways without a status field can't accidentally surface a
    // blocked skill in the picker.
    mockSkillsResponse([
      { id: "safe", name: "safe-skill", description: "Safe one" },
      {
        id: "blocked",
        name: "blocked-skill",
        description: "Should also be hidden",
        runnable: false,
      },
    ]);

    const { result } = renderHook(() => useSlashCommands());

    await waitFor(() => {
      const labels = result.current.map((c) => c.label);
      expect(labels).toContain("safe-skill");
    });

    const labels = result.current.map((c) => c.label);
    expect(labels).not.toContain("blocked-skill");
  });

  it("dynamic-agent view drops flagged skills even when their id is attached", async () => {
    // The dynamic-agent path filters the catalog to the agent's
    // ``agentSkillIds``. A flagged skill might still be on the agent's
    // attached list (legacy attachment, before scan flipped); the picker
    // must not offer it regardless.
    mockSkillsResponse([
      { id: "skill-good", name: "good", description: "Allowed", scan_status: "passed" },
      {
        id: "skill-bad",
        name: "bad",
        description: "Attached but flagged",
        scan_status: "flagged",
      },
    ]);

    const { result } = renderHook(() =>
      useSlashCommands(["skill-good", "skill-bad"]),
    );

    await waitFor(() => {
      expect(result.current.map((c) => c.label)).toContain("good");
    });

    const labels = result.current.map((c) => c.label);
    expect(labels).not.toContain("bad");
  });

  it("includes built-in commands regardless of catalog filtering", async () => {
    // Defensive sanity: filtering should never strip ``/skills``,
    // ``/effort``, ``/help``, ``/clear`` -- they are static and not part of the
    // catalog response.
    mockSkillsResponse([
      { id: "evil", name: "evil-skill", scan_status: "flagged" },
    ]);

    const { result } = renderHook(() => useSlashCommands());

    await waitFor(() => {
      expect(result.current.find((c) => c.label === "help")).toBeDefined();
    });

    const labels = result.current.map((c) => c.label);
    expect(labels).toEqual(expect.arrayContaining(["skills", "effort", "help", "clear"]));
    expect(result.current.find((c) => c.label === "effort")).toEqual(
      expect.objectContaining({
        description: "Set this chat's reasoning effort (low|medium|high|max)",
        value: "/effort ",
      }),
    );
    expect(labels).not.toContain("evil-skill");
  });

  it("uses enabled MCP servers and configured subagents for mentions", () => {
    const { result } = renderHook(() => useSlashCommands(
      [],
      { github: true, jira: false, rag: ["search"] },
      [{ agent_id: "reviewer-id", name: "reviewer", description: "Reviews changes" }],
    ));

    expect(result.current).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "github", category: "mcp", value: "@github" }),
      expect.objectContaining({ label: "rag", category: "mcp", value: "@rag" }),
      expect.objectContaining({ label: "reviewer", category: "subagent", value: "@reviewer" }),
    ]));
    expect(result.current).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "jira" }),
    ]));
  });
});
