/**
 * @jest-environment jsdom
 */

import { fireEvent,render,screen,waitFor } from "@testing-library/react";

import { UserDefaultAgentsPanel } from "../UserDefaultAgentsPanel";

const AGENTS = [
  { id: "sre",name: "Basic SRE",description: "Handles SRE workflows" },
  { id: "kb",name: "Knowledge Base Agent",description: "Answers from knowledge bases" },
];

interface WebexBotSetting {
  agent_id?: string | null;
  bot_id: string;
  bot_name: string;
  denied?: boolean;
  editable?: boolean;
}

interface MockOptions {
  failWrites?: boolean;
  integrations?: { slack: boolean;webex: boolean };
  platformDefault?: string | null;
  preferences?: {
    slack_default_agent_id?: string | null;
    web_default_agent_id?: string | null;
  };
  webexBots?: WebexBotSetting[];
}

const DEFAULT_WEBEX_BOT: WebexBotSetting = {
  bot_id: "primary",
  bot_name: "Primary",
  agent_id: null,
  editable: true,
  denied: false,
};

function installFetchMock({
  failWrites = false,
  integrations = { slack: true,webex: true },
  platformDefault = "sre",
  preferences = {},
  webexBots = [DEFAULT_WEBEX_BOT],
}: MockOptions = {}): jest.Mock {
  const mock = jest.fn(async (input: RequestInfo | URL,init?: RequestInit) => {
    const path = String(input);
    if (path.includes("/api/user/accessible-agents")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { agents: AGENTS,total: AGENTS.length,page: 1,page_size: 100 },
        }),
      } as Response;
    }
    if (path.includes("/api/user/preferences") && init?.method === "PUT") {
      return {
        ok: !failWrites,
        status: failWrites ? 503 : 200,
        json: async () => failWrites
          ? ({ success: false,error: "Preference service unavailable" })
          : ({ success: true,data: {} }),
      } as Response;
    }
    if (path.includes("/api/user/preferences")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            platform_default_agent_id: platformDefault,
            web_default_agent_id: null,
            slack_default_agent_id: null,
            integrations,
            webex_bots: integrations.webex ? webexBots : [],
            ...preferences,
          },
        }),
      } as Response;
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  global.fetch = mock;
  return mock;
}

describe("UserDefaultAgentsPanel",() => {
  beforeEach(() => {
    jest.clearAllMocks();
    installFetchMock();
  });

  it("shows the resolved platform fallback on every connected surface",async () => {
    render(<UserDefaultAgentsPanel />);

    expect(await screen.findByRole("combobox",{ name: "Web default agent" })).toHaveTextContent(
      "Use platform default (Basic SRE)",
    );
    expect(screen.getByRole("combobox",{ name: "Slack default agent" })).toHaveTextContent(
      "Use platform default (Basic SRE)",
    );
    expect(screen.getByRole("combobox",{ name: "Webex default agent" })).toHaveTextContent(
      "Use platform default (Basic SRE)",
    );
    expect(screen.queryByRole("button",{ name: /save personal default agents/i })).not.toBeInTheDocument();
  });

  it("auto-saves Slack and Webex independently on selection",async () => {
    const fetchMock = installFetchMock();
    render(<UserDefaultAgentsPanel />);

    fireEvent.click(await screen.findByRole("combobox",{ name: "Slack default agent" }));
    fireEvent.click(await screen.findByRole("option",{ name: "Knowledge Base Agent" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/user/preferences",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ slack_default_agent_id: "kb" }),
        }),
      );
    });

    fireEvent.click(screen.getByRole("combobox",{ name: "Webex default agent" }));
    fireEvent.click(await screen.findByRole("option",{ name: "Knowledge Base Agent" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/user/preferences",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ webex_default_agent_id: { bot_id: "primary",agent_id: "kb" } }),
        }),
      );
    });
  });

  it("shows one row per Webex bot when the user is reachable via more than one",async () => {
    installFetchMock({
      webexBots: [
        DEFAULT_WEBEX_BOT,
        { bot_id: "secondary",bot_name: "Secondary",agent_id: null,editable: true,denied: false },
      ],
    });
    render(<UserDefaultAgentsPanel />);

    expect(await screen.findByRole("combobox",{ name: "Webex default agent — Primary" })).toBeInTheDocument();
    expect(screen.getByRole("combobox",{ name: "Webex default agent — Secondary" })).toBeInTheDocument();
  });

  it("renders an admin-managed Webex bot read-only instead of as a picker",async () => {
    installFetchMock({
      webexBots: [
        { bot_id: "primary",bot_name: "Primary",agent_id: "sre",editable: false,denied: false },
      ],
    });
    render(<UserDefaultAgentsPanel />);

    expect(await screen.findByText("Basic SRE")).toBeInTheDocument();
    expect(
      screen.getByText("An admin manages your default agent for Primary in the 1:1 Messages settings."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("combobox",{ name: "Webex default agent" })).not.toBeInTheDocument();
  });

  it("renders a denied Webex bot read-only with a denial caption",async () => {
    installFetchMock({
      webexBots: [
        { bot_id: "primary",bot_name: "Primary",agent_id: "sre",editable: false,denied: true },
      ],
    });
    render(<UserDefaultAgentsPanel />);

    expect(
      await screen.findByText("An admin has disabled direct messages for you on Primary."),
    ).toBeInTheDocument();
  });

  it("clears one override back to the platform default immediately",async () => {
    const fetchMock = installFetchMock({
      integrations: { slack: true,webex: false },
      preferences: { slack_default_agent_id: "kb" },
    });
    render(<UserDefaultAgentsPanel />);

    const slack = await screen.findByRole("combobox",{ name: "Slack default agent" });
    fireEvent.click(slack);
    fireEvent.click(await screen.findByRole("option",{ name: /Use platform default/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/user/preferences",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ slack_default_agent_id: null }),
        }),
      );
    });
    expect(slack).toHaveTextContent("Use platform default (Basic SRE)");
  });

  it("rolls back only the failed surface and exposes retry",async () => {
    installFetchMock({ failWrites: true,integrations: { slack: false,webex: false } });
    render(<UserDefaultAgentsPanel />);

    const web = await screen.findByRole("combobox",{ name: "Web default agent" });
    fireEvent.click(web);
    fireEvent.click(await screen.findByRole("option",{ name: "Knowledge Base Agent" }));

    await waitFor(() => {
      expect(web).toHaveTextContent("Use platform default (Basic SRE)");
      expect(screen.getByText("Preference service unavailable")).toBeInTheDocument();
      expect(screen.getByRole("button",{ name: "Retry" })).toBeInTheDocument();
    });
  });

  it("suppresses writes when disabled",async () => {
    const fetchMock = installFetchMock();
    render(<UserDefaultAgentsPanel disabled />);

    expect(await screen.findByRole("combobox",{ name: "Web default agent" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/user/preferences",
      expect.objectContaining({ method: "PUT" }),
    );
  });
});
