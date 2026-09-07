/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { IngestionSourceConfig } from "@/types/ingestion-source";

jest.mock("@/components/ui/toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

// Keep the test focused on form semantics instead of picker popovers.
jest.mock("@/components/ui/team-picker", () => ({
  TeamPicker: ({
    value,
    onChange,
    options,
  }: {
    value: string;
    onChange: (slug: string) => void;
    options: Array<{ slug: string }>;
  }) => (
    <input
      data-testid="mock-owner-team"
      data-options={options.map((option) => option.slug).join(",")}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
  TeamMultiPicker: ({ selected, onChange }: {
    selected: string[];
    onChange: (slugs: string[]) => void;
  }) => (
    <input
      data-testid="mock-search-teams"
      value={selected.join(",")}
      onChange={(e) => onChange(e.target.value.split(",").filter(Boolean))}
    />
  ),
}));

jest.mock("@/components/ui/access-subject-picker", () => ({
  AccessSubjectPicker: ({
    value,
    onChange,
    teams,
  }: {
    value: { kind: "user" | "team"; id: string } | null;
    onChange: (next: { kind: "team"; id: string }) => void;
    teams: Array<{ slug: string }>;
  }) => (
    <input
      data-testid="mock-owner-team"
      data-options={teams.map((team) => team.slug).join(",")}
      value={value?.id ?? ""}
      onChange={(event) => onChange({ kind: "team", id: event.target.value })}
    />
  ),
  AccessSubjectMultiPicker: ({
    selected,
    onChange,
  }: {
    selected: Array<{ kind: "user" | "team"; id: string }>;
    onChange: (next: Array<{ kind: "team"; id: string }>) => void;
  }) => (
    <input
      data-testid="mock-search-teams"
      value={selected.map((ref) => ref.id).join(",")}
      onChange={(event) => onChange(
        event.target.value.split(",").filter(Boolean).map((id) => ({ kind: "team", id })),
      )}
    />
  ),
}));

import { IngestionSourceForm } from "../IngestionSourceForm";

function jsonOk(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

beforeEach(() => {
  global.fetch = jest.fn().mockImplementation(async (url: string) => {
    if (url.includes("/api/rbac/ingest-teams")) {
      return jsonOk({
        teams: [{ _id: "t1", slug: "author-team", name: "Author Team" }],
      });
    }
    if (url.includes("/api/dynamic-agents/teams")) {
      return jsonOk({
        success: true,
        data: [
          { _id: "t1", slug: "team-example", name: "Example Team" },
          { _id: "t2", slug: "membership-only", name: "Membership Only" },
        ],
      });
    }
    return jsonOk({});
  }) as unknown as typeof fetch;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("<IngestionSourceForm /> — create", () => {
  it("allows a personal create once name and identity fields are filled", async () => {
    const user = userEvent.setup();
    const onSave = jest.fn().mockResolvedValue(undefined);
    render(<IngestionSourceForm open onClose={jest.fn()} onSave={onSave} initial={null} />);

    const createBtn = screen.getByRole("button", { name: /create source/i });
    expect(createBtn).toBeDisabled();

    await user.type(screen.getByLabelText(/^name/i), "Example Channel");
    expect(createBtn).toBeDisabled();

    await user.type(screen.getByLabelText(/channel id/i), "C123");
    await waitFor(() => expect(createBtn).not.toBeDisabled());
  });

  it("offers only data-source-author teams as Owners on create", async () => {
    render(<IngestionSourceForm open onClose={jest.fn()} onSave={jest.fn()} initial={null} />);

    await waitFor(() =>
      expect(screen.getByTestId("mock-owner-team")).toHaveAttribute(
        "data-options",
        "author-team",
      ),
    );
  });

  it("submits a slack_channel payload with identity fields and owner_team_slug on create", async () => {
    const user = userEvent.setup();
    const onSave = jest.fn().mockResolvedValue(undefined);
    render(<IngestionSourceForm open onClose={jest.fn()} onSave={onSave} initial={null} />);

    await user.type(screen.getByLabelText(/^name/i), "Example Channel");
    await user.type(screen.getByLabelText(/channel id/i), "C123");
    await user.type(screen.getByTestId("mock-owner-team"), "team-example");

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /create source/i }));
    });

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        source_type: "slack_channel",
        name: "Example Channel",
        channel_id: "C123",
        owner_team_slug: "team-example",
      }),
    );
  });

  it("switches identity fields when source_type changes", async () => {
    const user = userEvent.setup();
    render(<IngestionSourceForm open onClose={jest.fn()} onSave={jest.fn()} initial={null} />);

    expect(screen.getByLabelText(/channel id/i)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/source type/i), "web_url");
    expect(screen.queryByLabelText(/channel id/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^url/i)).toBeInTheDocument();
  });

  it("opens with a requested managed source type", () => {
    render(
      <IngestionSourceForm
        open
        onClose={jest.fn()}
        onSave={jest.fn()}
        initial={null}
        defaultSourceType="jira_project"
      />,
    );

    expect(screen.getByLabelText(/source type/i)).toHaveValue("jira_project");
    expect(screen.getByLabelText(/project key/i)).toBeInTheDocument();
  });

  it("renders a requested source inline without opening a dialog", () => {
    render(
      <IngestionSourceForm
        open
        displayMode="inline"
        onClose={jest.fn()}
        onSave={jest.fn()}
        initial={null}
        defaultSourceType="confluence_space"
      />,
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/source type/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/space key/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^url/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/starting page url/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/confluence url/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ingest source/i })).toBeInTheDocument();
    expect(screen.getByText(/starts ingestion immediately/i)).toBeInTheDocument();
  });

  it("derives the Confluence base URL and page ID from one page URL", async () => {
    const user = userEvent.setup();
    const onSave = jest.fn().mockResolvedValue(undefined);
    render(
      <IngestionSourceForm
        open
        displayMode="inline"
        onClose={jest.fn()}
        onSave={onSave}
        initial={null}
        defaultSourceType="confluence_space"
      />,
    );

    await user.type(screen.getByLabelText(/^name/i), "Example pages");
    await user.type(
      screen.getByLabelText(/^url/i),
      "https://example.atlassian.net/wiki/spaces/ENG/pages/123/Overview",
    );
    await user.type(screen.getByLabelText(/space key/i), "ENG");
    await user.click(screen.getByRole("button", { name: /ingest source/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        source_type: "confluence_space",
        url: "https://example.atlassian.net/wiki/spaces/ENG/pages/123/Overview",
        confluence_url: "https://example.atlassian.net/wiki",
        space_key: "ENG",
        start_page_url:
          "https://example.atlassian.net/wiki/spaces/ENG/pages/123/Overview",
      }),
    );
  });

  it("creates web sources with the existing sitemap crawl defaults", async () => {
    const user = userEvent.setup();
    const onSave = jest.fn().mockResolvedValue(undefined);
    render(<IngestionSourceForm open onClose={jest.fn()} onSave={onSave} initial={null} />);

    await user.selectOptions(screen.getByLabelText(/source type/i), "web_url");
    await user.type(screen.getByLabelText(/^name/i), "Example documentation");
    await user.type(screen.getByLabelText(/^url/i), "https://example.com/docs");
    await user.click(screen.getByRole("button", { name: /create source/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        source_type: "web_url",
        url: "https://example.com/docs",
        settings: expect.objectContaining({
          crawl_mode: "sitemap",
          max_pages: 2000,
          follow_external_links: true,
        }),
      }),
    );
  });

  it("starts new sources inside tighter platform limits", async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes("/api/rbac/ingest-teams")) {
        return jsonOk({ teams: [] });
      }
      if (url.includes("/api/dynamic-agents/teams")) {
        return jsonOk({ success: true, data: [] });
      }
      return jsonOk({
        success: true,
        data: {
          rag_ingestor_limits: {
            shared: {
              max_chunk_size: 5_000,
              max_chunk_overlap: 300,
              max_reload_interval_seconds: 3_600,
            },
            web: {
              max_pages: 100,
              max_concurrent_requests: 5,
              min_download_delay_seconds: 1,
            },
          },
        },
      });
    }) as unknown as typeof fetch;

    render(
      <IngestionSourceForm
        open
        onClose={jest.fn()}
        onSave={jest.fn()}
        initial={null}
        defaultSourceType="web_url"
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText(/maximum pages/i)).toHaveValue(100);
      expect(screen.getByLabelText(/chunk size/i)).toHaveValue(5_000);
      expect(screen.getByLabelText(/chunk overlap/i)).toHaveValue(300);
      expect(screen.getByLabelText(/reload interval/i)).toHaveValue(3_600);
    });
  });
});

describe("<IngestionSourceForm /> — edit", () => {
  const initial: IngestionSourceConfig = {
    source_id: "slack-channel-C1",
    source_type: "slack_channel",
    channel_id: "C1",
    name: "example-channel",
    description: "",
    status: "active",
    default_chunk_size: 10000,
    default_chunk_overlap: 2000,
    reload_interval: 86400,
    config_driven: false,
    config_import_adopted: false,
    visibility: "team",
    owner_team_slug: "team-example",
    shared_with_teams: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };

  it("disables the source_type selector and identity fields", () => {
    render(<IngestionSourceForm open onClose={jest.fn()} onSave={jest.fn()} initial={initial} />);
    expect(screen.getByLabelText(/source type/i)).toBeDisabled();
    expect(screen.getByLabelText(/channel id/i)).toBeDisabled();
  });

  it("offers membership teams for an existing source ownership transfer", async () => {
    render(<IngestionSourceForm open onClose={jest.fn()} onSave={jest.fn()} initial={initial} />);

    await waitFor(() =>
      expect(screen.getByTestId("mock-owner-team")).toHaveAttribute(
        "data-options",
        "team-example,membership-only",
      ),
    );
  });

  it("never renders a visibility control", () => {
    render(<IngestionSourceForm open onClose={jest.fn()} onSave={jest.fn()} initial={initial} />);
    expect(screen.queryByLabelText(/visibility/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^global$/i)).not.toBeInTheDocument();
  });

  it("submits only mutable fields on save (no identity/source_type)", async () => {
    const user = userEvent.setup();
    const onSave = jest.fn().mockResolvedValue(undefined);
    render(<IngestionSourceForm open onClose={jest.fn()} onSave={onSave} initial={initial} />);

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const payload = onSave.mock.calls[0][0];
    expect(payload).not.toHaveProperty("source_type");
    expect(payload).not.toHaveProperty("channel_id");
    expect(payload).not.toHaveProperty("source_id");
  });

  it("keeps requested Search access selected while approval is pending", async () => {
    const user = userEvent.setup();
    const onSave = jest.fn().mockResolvedValue(undefined);
    render(
      <IngestionSourceForm
        open
        onClose={jest.fn()}
        onSave={onSave}
        initial={initial}
        pendingPublicationRequest={{
          id: "request-primary",
          status: "pending",
          requested_state: {
            search_team_slugs: ["everyone"],
            search_user_subjects: [],
          },
          effective_state: {
            search_team_slugs: [],
            search_user_subjects: [],
          },
          risk_facts: {
            organization_wide: true,
            target_team_slugs: ["everyone"],
            added_team_slugs: ["everyone"],
            reasons: ["new organization-wide audience"],
          },
          requester: { subject: "test-user" },
          created_at: "2026-01-01T00:00:00.000Z",
        }}
      />,
    );

    expect(screen.getByTestId("mock-search-teams")).toHaveValue("everyone");
    expect(screen.getByText("Waiting for approval")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ search_team_slugs: ["everyone"] }),
    );
  });
});
