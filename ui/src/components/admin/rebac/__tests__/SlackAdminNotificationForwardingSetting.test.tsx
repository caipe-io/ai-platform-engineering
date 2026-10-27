/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";

import { ToastProvider } from "@/components/ui/toast";

jest.mock("@/components/ui/searchable-picker", () => ({
  SearchablePicker: ({
    options,
    selected,
    onSelect,
    ariaLabel,
    disabled,
    loading,
  }: {
    options: { id: string; name: string }[];
    selected?: { id: string; name: string };
    onSelect: (option: { id: string; name: string }) => void;
    ariaLabel?: string;
    disabled?: boolean;
    loading?: boolean;
  }) => (
    <select
      aria-label={ariaLabel}
      aria-busy={loading}
      value={selected?.id ?? ""}
      disabled={disabled}
      onChange={(event) => {
        const option = options.find((candidate) => candidate.id === event.target.value);
        if (option) onSelect(option);
      }}
    >
      <option value="">Select a channel</option>
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.name}
        </option>
      ))}
    </select>
  ),
}));

jest.mock("../slack/SlackUserTokenInput", () => ({
  SlackUserTokenInput: ({
    label,
    value,
    onChange,
    disabled,
  }: {
    label: string;
    value: string[];
    onChange: (next: string[]) => void;
    disabled?: boolean;
  }) => (
    <input
      aria-label={label}
      disabled={disabled}
      defaultValue=""
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          const target = event.target as HTMLInputElement;
          const next = target.value.trim();
          if (next) {
            onChange([...value, next]);
            target.value = "";
          }
        }
      }}
    />
  ),
}));

import { SlackAdminNotificationForwardingSetting } from "../SlackAdminNotificationForwardingSetting";

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

const CHANNELS_PAYLOAD = {
  success: true,
  data: {
    channels: [
      { id: "C100", name: "platform-admins" },
      { id: "C200", name: "security-alerts" },
    ],
  },
};

function mockFetch(options: {
  config?: unknown;
  configStatus?: number;
  channelsStatus?: number;
  patchResponse?: unknown;
  patchStatus?: number;
}) {
  const {
    config = { success: true, data: { enabled: false, channel_id: null, channel_name: null, ping_user_ids: [] } },
    configStatus = 200,
    channelsStatus = 200,
    patchResponse,
    patchStatus = 200,
  } = options;

  global.fetch = jest.fn((url: RequestInfo | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("/api/admin/slack/admin-notification-forwarding") && (!init || init.method === undefined)) {
      return jsonResponse(config, configStatus);
    }
    if (href.includes("/api/admin/slack/available-channels")) {
      return channelsStatus === 503
        ? jsonResponse({ error: "SLACK_BOT_TOKEN is not configured" }, 503)
        : jsonResponse(CHANNELS_PAYLOAD, channelsStatus);
    }
    if (href.includes("/api/admin/slack/admin-notification-forwarding") && init?.method === "PATCH") {
      return jsonResponse(
        patchResponse ?? { success: true, data: JSON.parse(String(init.body)) },
        patchStatus,
      );
    }
    return jsonResponse({ success: false, error: "unexpected request" }, 404);
  }) as unknown as typeof fetch;
}

function renderSetting(disabled = false) {
  return render(
    <ToastProvider>
      <SlackAdminNotificationForwardingSetting disabled={disabled} />
    </ToastProvider>,
  );
}

afterEach(() => {
  jest.restoreAllMocks();
});

it("renders the fetched config", async () => {
  mockFetch({
    config: {
      success: true,
      data: { enabled: true, channel_id: "C100", channel_name: "platform-admins", ping_user_ids: ["U1"] },
    },
  });

  renderSetting();

  expect(await screen.findByRole("switch", { name: /enable forwarding/i })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: /slack channel to forward/i }),
    ).toHaveValue("C100"),
  );
});

it("renders nothing for a viewer who lacks access to this setting", async () => {
  mockFetch({ configStatus: 403 });

  const { container } = renderSetting();

  await waitFor(() => expect(container.textContent).toBe(""));
  expect(screen.queryByRole("switch", { name: /enable forwarding/i })).not.toBeInTheDocument();
});

it("marks the setting dirty after toggling and selecting a channel, then saves the right payload", async () => {
  mockFetch({});
  renderSetting();

  const switchControl = await screen.findByRole("switch", { name: /enable forwarding/i });
  fireEvent.click(switchControl);

  const channelPicker = await screen.findByRole("combobox", { name: /slack channel to forward/i });
  await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(1));
  fireEvent.change(channelPicker, { target: { value: "C100" } });

  const pingInput = screen.getByLabelText("Users to ping");
  fireEvent.change(pingInput, { target: { value: "U999" } });
  fireEvent.keyDown(pingInput, { key: "Enter" });

  const saveButton = screen.getByRole("button", { name: /save admin notification forwarding/i });
  expect(saveButton).toBeEnabled();
  fireEvent.click(saveButton);

  await waitFor(() => {
    const patchCall = (global.fetch as jest.Mock).mock.calls.find(
      ([, init]) => init?.method === "PATCH",
    );
    expect(patchCall).toBeTruthy();
    const body = JSON.parse(String(patchCall![1].body));
    expect(body).toEqual({
      enabled: true,
      channel_id: "C100",
      channel_name: "platform-admins",
      ping_user_ids: ["U999"],
    });
  });

  expect(await screen.findByText("Admin notification forwarding saved.")).toBeInTheDocument();
});

it("shows the server error message when saving fails", async () => {
  mockFetch({
    config: {
      success: true,
      data: { enabled: true, channel_id: "C100", channel_name: "platform-admins", ping_user_ids: [] },
    },
    patchResponse: { success: false, error: "Channel is required when forwarding is enabled" },
    patchStatus: 400,
  });
  renderSetting();

  await screen.findByRole("switch", { name: /enable forwarding/i });
  const pingInput = screen.getByLabelText("Users to ping");
  fireEvent.change(pingInput, { target: { value: "U1" } });
  fireEvent.keyDown(pingInput, { key: "Enter" });

  fireEvent.click(screen.getByRole("button", { name: /save admin notification forwarding/i }));

  expect(
    await screen.findByText("Channel is required when forwarding is enabled"),
  ).toBeInTheDocument();
});

it("blocks saving when enabling without a channel, without calling PATCH", async () => {
  mockFetch({});
  renderSetting();

  const switchControl = await screen.findByRole("switch", { name: /enable forwarding/i });
  fireEvent.click(switchControl);

  const saveButton = screen.getByRole("button", { name: /save admin notification forwarding/i });
  expect(saveButton).toBeEnabled();
  fireEvent.click(saveButton);

  expect(
    await screen.findByText(/select a slack channel before enabling/i),
  ).toBeInTheDocument();
  expect(
    (global.fetch as jest.Mock).mock.calls.some(([, init]) => init?.method === "PATCH"),
  ).toBe(false);
});

it("falls back to a manual channel-ID input when channel discovery is unavailable", async () => {
  mockFetch({ channelsStatus: 503 });
  renderSetting();

  await screen.findByRole("switch", { name: /enable forwarding/i });
  const manualInput = await screen.findByPlaceholderText(/paste a slack channel id/i);
  expect(manualInput).toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: /slack channel to forward/i })).not.toBeInTheDocument();

  fireEvent.change(manualInput, { target: { value: "C999999999" } });
  expect(manualInput).toHaveValue("C999999999");
});
