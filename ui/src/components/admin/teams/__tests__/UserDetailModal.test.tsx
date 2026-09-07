import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UserDetailModal } from "../UserDetailModal";

const updateSession = jest.fn();

jest.mock("next-auth/react", () => ({
  useSession: () => ({ update: updateSession }),
}));

const userResponse = {
  success: true,
  data: {
    user: {
      id: "user-1",
      username: "test-user",
      email: "test-user@example.com",
      firstName: "Test",
      lastName: "User",
      enabled: true,
      createdAt: 0,
      attributes: {
        slack_user_id: ["U123SLACK"],
        webex_user_id: ["person-abc"],
        webex_user_email: ["person-abc@example.com"],
      },
      slackLinkStatus: "linked",
      realmRoles: [
        { id: "legacy-admin", name: "admin" },
        { id: "legacy-chat", name: "chat_user" },
        { id: "legacy-kb", name: "kb_reader:kb-1" },
        { id: "legacy-agent", name: "agent_user:agent-1" },
      ],
      sessions: [],
      federatedIdentities: [],
      teams: [{ team_id: "platform", tenant_id: "caipe" }],
      lastAccess: null,
    },
  },
};

const teamsResponse = {
  success: true,
  data: {
    teams: [{ name: "platform" }, { name: "security" }],
  },
};

const accessResponse = {
  success: true,
  data: {
    user: { id: "user-1", email: "test-user@example.com" },
    teams: [{ team_slug: "platform", team_name: "Platform", role: "admin" }],
    access: {
      agents: [
        {
          id: "agent-github",
          name: "GitHub agent",
          capability: "use",
          via: [{ team_slug: "platform", team_name: "Platform", role: "admin" }],
        },
      ],
      tools: [
        {
          id: "jira_*",
          name: "jira_*",
          capability: "call",
          via: [{ team_slug: "platform", team_name: "Platform", role: "admin" }],
        },
      ],
      knowledge_bases: [
        {
          id: "source-1",
          name: "Example runbooks",
          capability: "owner",
          via: [{ team_slug: "platform", team_name: "Platform", role: "admin" }],
        },
        {
          id: "source-1",
          name: "Example runbooks",
          capability: "search",
          via: [{ team_slug: "platform", team_name: "Platform", role: "admin" }],
        },
      ],
      skills: [],
      tasks: [],
    },
  },
};

describe("UserDetailModal", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(window, "confirm").mockReturnValue(true);
    global.fetch = jest.fn((url: string) => {
      if (url.includes("/api/admin/slack/users/user-1")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ success: true, data: { revoked: true } }),
        });
      }
      if (url.includes("/api/admin/webex/users/user-1")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ success: true, data: { revoked: true } }),
        });
      }
      if (url.includes("/api/admin/users/user-1/access")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(accessResponse),
        });
      }
      if (url.includes("/api/admin/users/user-1")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(userResponse),
        });
      }
      if (url.includes("/api/admin/teams")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(teamsResponse),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ success: false, error: "unexpected fetch" }),
      });
    }) as jest.Mock;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("does not expose Keycloak role management in the user detail modal", async () => {
    render(
      <UserDetailModal
        userId="user-1"
        onClose={jest.fn()}
        onSaved={jest.fn()}
      />
    );

    expect(await screen.findByText("Test User")).toBeInTheDocument();

    expect(screen.queryByText("Realm roles")).not.toBeInTheDocument();
    expect(screen.queryByText("Per-KB roles")).not.toBeInTheDocument();
    expect(screen.queryByText("Per-agent roles")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Add role")).not.toBeInTheDocument();
    expect(screen.queryByText("admin")).not.toBeInTheDocument();
    expect(screen.queryByText("chat_user")).not.toBeInTheDocument();

    await waitFor(() => {
      expect(global.fetch).not.toHaveBeenCalledWith("/api/admin/roles");
    });
  });

  it("shows resource access grouped with the granting team as the reason", async () => {
    render(
      <UserDetailModal
        userId="user-1"
        onClose={jest.fn()}
        onSaved={jest.fn()}
      />
    );

    expect(await screen.findByText("Test User")).toBeInTheDocument();

    // Access section renders the resolved agent + tool with the team chip.
    expect(await screen.findByText("GitHub agent")).toBeInTheDocument();
    expect(screen.getByText("jira_*")).toBeInTheDocument();
    expect(screen.getByText("RAG")).toBeInTheDocument();
    expect(screen.getAllByText("Example runbooks")).toHaveLength(2);
    expect(screen.getByText("owner")).toBeInTheDocument();
    expect(screen.getByText("search")).toBeInTheDocument();
    expect(screen.getByText("Access")).toBeInTheDocument();
    expect(screen.getAllByText("Platform").length).toBeGreaterThan(0);
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/admin/users/user-1/access"
    );
  });

  it("collapses long access groups behind a Show more toggle", async () => {
    const manyToolsAccess = {
      success: true,
      data: {
        user: { id: "user-1", email: "test-user@example.com" },
        teams: [{ team_slug: "platform", team_name: "Platform", role: "member" }],
        access: {
          agents: [],
          tools: Array.from({ length: 20 }, (_, i) => ({
            id: `tool-${i}`,
            name: `tool-${i}`,
            capability: "call",
            via: [{ team_slug: "platform", team_name: "Platform", role: "member" }],
          })),
          knowledge_bases: [],
          skills: [],
          tasks: [],
        },
      },
    };
    (global.fetch as jest.Mock).mockImplementation((url: string) => {
      if (url.includes("/api/admin/users/user-1/access")) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(manyToolsAccess) });
      }
      if (url.includes("/api/admin/users/user-1")) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(userResponse) });
      }
      if (url.includes("/api/admin/teams")) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(teamsResponse) });
      }
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ success: false }) });
    });

    render(
      <UserDetailModal userId="user-1" onClose={jest.fn()} onSaved={jest.fn()} />
    );

    // Only the first 8 of 20 tools render until expanded.
    expect(await screen.findByText("tool-0")).toBeInTheDocument();
    expect(screen.getByText("tool-7")).toBeInTheDocument();
    expect(screen.queryByText("tool-8")).not.toBeInTheDocument();

    const showMore = screen.getByRole("button", { name: /show 12 more/i });
    fireEvent.click(showMore);

    expect(screen.getByText("tool-19")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /show less/i }));
    expect(screen.queryByText("tool-8")).not.toBeInTheDocument();
  });

  it("collapses long team memberships behind a Show more toggle", async () => {
    const manyTeamsUser = {
      ...userResponse,
      data: {
        ...userResponse.data,
        user: {
          ...userResponse.data.user,
          teams: Array.from({ length: 14 }, (_, i) => ({
            team_id: `team-${i}`,
            tenant_id: "caipe",
          })),
        },
      },
    };
    (global.fetch as jest.Mock).mockImplementation((url: string) => {
      if (url.includes("/api/admin/users/user-1/access")) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(accessResponse) });
      }
      if (url.includes("/api/admin/users/user-1")) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(manyTeamsUser) });
      }
      if (url.includes("/api/admin/teams")) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(teamsResponse) });
      }
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ success: false }) });
    });

    render(
      <UserDetailModal userId="user-1" onClose={jest.fn()} onSaved={jest.fn()} />
    );

    expect(await screen.findByText("team-0")).toBeInTheDocument();
    expect(screen.getByText("team-7")).toBeInTheDocument();
    expect(screen.queryByText("team-8")).not.toBeInTheDocument();
    expect(screen.getByText("+6 more")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /show 6 more/i }));

    expect(screen.getByText("team-13")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /collapse/i }));
    expect(screen.queryByText("team-8")).not.toBeInTheDocument();
  });

  it("shows Webex link status and the linked account's email, not the raw Webex id", async () => {
    render(
      <UserDetailModal
        userId="user-1"
        onClose={jest.fn()}
        onSaved={jest.fn()}
      />
    );

    expect(await screen.findByText("person-abc@example.com")).toBeInTheDocument();
    expect(screen.getByText("Webex")).toBeInTheDocument();
    expect(screen.queryByText("person-abc")).not.toBeInTheDocument();
  });

  it("falls back to the raw Webex id when linked via the admin flow with no email captured", async () => {
    const noEmailUser = {
      ...userResponse,
      data: {
        ...userResponse.data,
        user: {
          ...userResponse.data.user,
          attributes: {
            ...userResponse.data.user.attributes,
            webex_user_email: undefined,
          },
        },
      },
    };
    (global.fetch as jest.Mock).mockImplementation((url: string) => {
      if (url.includes("/api/admin/users/user-1/access")) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(accessResponse) });
      }
      if (url.includes("/api/admin/users/user-1")) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(noEmailUser) });
      }
      if (url.includes("/api/admin/teams")) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(teamsResponse) });
      }
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ success: false }) });
    });

    render(
      <UserDetailModal
        userId="user-1"
        onClose={jest.fn()}
        onSaved={jest.fn()}
      />
    );

    expect(await screen.findByText("person-abc")).toBeInTheDocument();
    expect(screen.queryByText("person-abc@example.com")).not.toBeInTheDocument();
  });

  it("renders account and connector details without mutation controls in read-only mode", async () => {
    render(
      <UserDetailModal
        userId="user-1"
        onClose={jest.fn()}
        onSaved={jest.fn()}
        readOnly
      />
    );

    expect(await screen.findByText("Test User")).toBeInTheDocument();
    expect(screen.getByRole("switch")).toBeDisabled();
    expect(screen.queryByRole("button", { name: /unlink webex/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /unlink slack/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/remove team platform/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Add team")).not.toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalledWith("/api/admin/teams");
  });

  it("scopes every profile read to the selected preview account", async () => {
    render(
      <UserDetailModal
        userId="user-1"
        onClose={jest.fn()}
        onSaved={jest.fn()}
        readOnly
        simulationTarget={{ type: "user", id: "preview-user" }}
      />
    );

    expect(await screen.findByText("Test User")).toBeInTheDocument();
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/admin/users/user-1?simulate_type=user&simulate_id=preview-user"
      );
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/admin/users/user-1/access?simulate_type=user&simulate_id=preview-user"
      );
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/admin/users/user-1/identity?simulate_type=user&simulate_id=preview-user"
      );
    });
  });

  it("can unlink Webex identity from the user detail modal", async () => {
    const onSaved = jest.fn();
    render(
      <UserDetailModal
        userId="user-1"
        onClose={jest.fn()}
        onSaved={onSaved}
      />
    );

    expect(await screen.findByText("person-abc@example.com")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /unlink webex/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/admin/webex/users/user-1", {
        method: "DELETE",
      });
      expect(onSaved).toHaveBeenCalled();
    });
  });

  it("can unlink Slack identity from the user detail modal", async () => {
    const onSaved = jest.fn();
    render(
      <UserDetailModal
        userId="user-1"
        onClose={jest.fn()}
        onSaved={onSaved}
      />
    );

    expect(await screen.findByText("U123SLACK")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /unlink slack/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/admin/slack/users/user-1", {
        method: "DELETE",
      });
      expect(onSaved).toHaveBeenCalled();
    });
  });
});
