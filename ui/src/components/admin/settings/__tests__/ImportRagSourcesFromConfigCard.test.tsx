/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";

jest.mock("@/components/ui/access-subject-picker", () => ({
  AccessSubjectPicker: ({
    teams,
    value,
    onChange,
    ariaLabel,
  }: {
    teams: { slug: string; name: string }[];
    value: { kind: "team" | "user"; id: string } | null;
    onChange: (ref: { kind: "team"; id: string } | null) => void;
    ariaLabel?: string;
  }) => (
    <select
      aria-label={ariaLabel}
      value={value?.id ?? ""}
      onChange={(event) =>
        onChange(
          event.target.value
            ? { kind: "team", id: event.target.value }
            : null,
        )
      }
    >
      <option value="">Select a person or team</option>
      {teams.map((team) => (
        <option key={team.slug} value={team.slug}>
          {team.name}
        </option>
      ))}
    </select>
  ),
  AccessSubjectMultiPicker: ({
    teams,
    selected,
    onChange,
    ariaLabel,
  }: {
    teams: { slug: string; name: string }[];
    selected: { kind: "team" | "user"; id: string }[];
    onChange: (next: { kind: "team"; id: string }[]) => void;
    ariaLabel?: string;
  }) => (
    <fieldset aria-label={ariaLabel}>
      {teams.map((team) => (
        <label key={team.slug}>
          <input
            type="checkbox"
            checked={selected.some((ref) => ref.id === team.slug)}
            onChange={() => {
              const exists = selected.some((ref) => ref.id === team.slug);
              onChange(
                exists
                  ? selected.filter((ref) => ref.id !== team.slug)
                  : [...selected, { kind: "team", id: team.slug }],
              );
            }}
          />
          {team.name}
        </label>
      ))}
    </fieldset>
  ),
}));

import { ImportRagSourcesFromConfigCard } from "../ImportRagSourcesFromConfigCard";

const PREVIEW_SOURCES = [
  {
    source_id: "slack-channel-C1",
    name: "primary",
    source_type: "slack_channel",
    in_db: true,
    already_adopted: false,
    importable: true,
  },
  {
    source_id: "slack-channel-C2",
    name: "secondary",
    source_type: "slack_channel",
    in_db: true,
    already_adopted: true,
    importable: false,
  },
  {
    source_id: "slack-channel-C3",
    name: "example",
    source_type: "slack_channel",
    in_db: false,
    already_adopted: false,
    importable: false,
    unavailable_reason: "not_seeded",
  },
];

const TEAMS = [
  { slug: "owner-team", name: "Owner Team" },
  { slug: "primary-team", name: "Primary Team" },
];

function mockFetch({
  preview = {
    success: true,
    data: { sources: PREVIEW_SOURCES, configured_source_count: 3 },
  },
  apply = {
    success: true,
    data: {
      sources: PREVIEW_SOURCES,
      adopted: ["slack-channel-C1"],
      skipped: [],
      configured_source_count: 3,
    },
  },
}: {
  preview?: object;
  apply?: object;
} = {}): void {
  global.fetch = jest.fn((url: RequestInfo | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("/api/admin/rag/sources/migrate-from-config")) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const payload = body.dry_run === false ? apply : preview;
      return Promise.resolve({
        json: () => Promise.resolve(payload),
      } as Response);
    }
    if (href === "/api/dynamic-agents/teams") {
      return Promise.resolve({
        json: () => Promise.resolve({ success: true, data: TEAMS }),
      } as Response);
    }
    return Promise.reject(new Error(`Unexpected fetch: ${href}`));
  });
}

describe("ImportRagSourcesFromConfigCard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch();
  });

  it("renders nothing for non-admins", () => {
    render(<ImportRagSourcesFromConfigCard isAdmin={false} />);
    expect(
      screen.queryByText("Adopt App-Config RAG Sources"),
    ).not.toBeInTheDocument();
  });

  it("shows app-config adoption controls for admins", () => {
    render(<ImportRagSourcesFromConfigCard isAdmin />);
    expect(screen.getByText("Adopt App-Config RAG Sources")).toBeInTheDocument();
    expect(
      screen.getByTestId("import-rag-sources-from-config-button"),
    ).toHaveTextContent("Review App-Config Sources");
  });

  it("preselects seeded config sources and disables unavailable entries", async () => {
    render(<ImportRagSourcesFromConfigCard isAdmin />);
    fireEvent.click(screen.getByTestId("import-rag-sources-from-config-button"));

    const seeded = await screen.findByTestId(
      "import-rag-source-checkbox-slack-channel-C1",
    );
    expect(seeded).toBeChecked();
    expect(
      screen.getByTestId("import-rag-source-checkbox-slack-channel-C2"),
    ).toBeDisabled();
    expect(
      screen.getByTestId("import-rag-source-checkbox-slack-channel-C3"),
    ).toBeDisabled();
    expect(screen.getByText("Already adopted")).toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.getByText(/Found 3 sources in app config/)).toBeInTheDocument();
    expect(screen.getByLabelText("Owner")).toBeInTheDocument();
    expect(screen.getByLabelText("Search Access")).toBeInTheDocument();
  });

  it("disables Adopt until an Owner is selected", async () => {
    render(<ImportRagSourcesFromConfigCard isAdmin />);
    fireEvent.click(screen.getByTestId("import-rag-sources-from-config-button"));

    await screen.findByTestId("import-rag-source-checkbox-slack-channel-C1");
    expect(screen.getByTestId("import-rag-sources-apply-button")).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Owner"), {
      target: { value: "owner-team" },
    });
    expect(
      screen.getByTestId("import-rag-sources-apply-button"),
    ).not.toBeDisabled();
  });

  it("adopts selected app-config source ids with the chosen Owner and no Search Access", async () => {
    render(<ImportRagSourcesFromConfigCard isAdmin />);
    fireEvent.click(screen.getByTestId("import-rag-sources-from-config-button"));

    await screen.findByTestId("import-rag-source-checkbox-slack-channel-C1");
    fireEvent.change(screen.getByLabelText("Owner"), {
      target: { value: "owner-team" },
    });
    fireEvent.click(screen.getByTestId("import-rag-sources-apply-button"));

    await waitFor(() => {
      expect(screen.getByTestId("import-rag-sources-result")).toHaveTextContent(
        "Adopted 1 source into editable database settings",
      );
    });
    const applyCall = (global.fetch as jest.Mock).mock.calls.find(([, init]) => {
      if (!init?.body) return false;
      return JSON.parse(String(init.body)).dry_run === false;
    });
    expect(JSON.parse(String(applyCall?.[1]?.body))).toEqual(
      expect.objectContaining({
        source_ids: ["slack-channel-C1"],
        owner_team_slug: "owner-team",
        search_team_slugs: [],
        search_user_subjects: [],
      }),
    );
  });

  it("adopts with an Owner and Search Access team both selected", async () => {
    render(<ImportRagSourcesFromConfigCard isAdmin />);
    fireEvent.click(screen.getByTestId("import-rag-sources-from-config-button"));

    await screen.findByTestId("import-rag-source-checkbox-slack-channel-C1");
    fireEvent.change(screen.getByLabelText("Owner"), {
      target: { value: "primary-team" },
    });
    fireEvent.click(
      screen.getByLabelText("Search Access").querySelector(
        'input[type="checkbox"]',
      ) as HTMLInputElement,
    );

    fireEvent.click(screen.getByTestId("import-rag-sources-apply-button"));
    await waitFor(() => {
      const applyCall = (global.fetch as jest.Mock).mock.calls.find(([, init]) => {
        if (!init?.body) return false;
        return JSON.parse(String(init.body)).dry_run === false;
      });
      expect(JSON.parse(String(applyCall?.[1]?.body))).toEqual(
        expect.objectContaining({
          owner_team_slug: "primary-team",
          search_team_slugs: ["owner-team"],
        }),
      );
    });
  });

  it("surfaces apply errors and per-source skip reasons", async () => {
    mockFetch({
      apply: {
        success: true,
        data: {
          sources: PREVIEW_SOURCES,
          adopted: [],
          skipped: [
            { source_id: "slack-channel-C1", reason: "already_adopted" },
          ],
        },
      },
    });
    render(<ImportRagSourcesFromConfigCard isAdmin />);
    fireEvent.click(screen.getByTestId("import-rag-sources-from-config-button"));

    await screen.findByTestId("import-rag-source-checkbox-slack-channel-C1");
    fireEvent.change(screen.getByLabelText("Owner"), {
      target: { value: "owner-team" },
    });
    fireEvent.click(screen.getByTestId("import-rag-sources-apply-button"));

    await waitFor(() => {
      expect(screen.getByTestId("import-rag-sources-result")).toHaveTextContent(
        "slack-channel-C1: already adopted",
      );
    });
  });

  it("keeps large app-config source lists in a bounded scroll area", async () => {
    const manySources = Array.from({ length: 200 }, (_, index) => ({
      source_id: `slack-channel-${index}`,
      name: `channel-${index}`,
      source_type: "slack_channel",
      in_db: true,
      already_adopted: false,
      importable: true,
    }));
    mockFetch({
      preview: {
        success: true,
        data: { sources: manySources, configured_source_count: 200 },
      },
    });

    render(<ImportRagSourcesFromConfigCard isAdmin />);
    fireEvent.click(screen.getByTestId("import-rag-sources-from-config-button"));

    await screen.findByTestId("import-rag-source-checkbox-slack-channel-0");
    expect(
      screen.getByTestId("import-rag-source-checkbox-slack-channel-199"),
    ).toBeInTheDocument();
    const checklist = screen.getByTestId("import-rag-sources-checklist");
    expect(checklist.className).toContain("max-h-56");
    expect(checklist.className).toContain("overflow-y-auto");
  });
});
