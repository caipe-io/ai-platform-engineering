/**
 * @jest-environment jsdom
 *
 * Covers the "Confirm Transfer" recovery flow on IngestionSourceForm: when
 * the PATCH route rejects an ownership transfer to a team the caller is not
 * an OpenFGA member of (TRANSFER_NOT_MEMBER_UNCONFIRMED), the form must
 * surface an inline confirm-and-retry instead of a dead-end error, and the
 * retry must carry `confirm_not_member: true`. Mirrors
 * `KbSharingPanel.transfer.test.tsx`.
 */

import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { IngestionSourceConfig } from "@/types/ingestion-source";
import { RagApiError } from "@/lib/rag-api";

jest.mock("@/components/ui/team-picker", () => ({
  TeamPicker: ({
    onChange,
  }: {
    onChange: (slug: string) => void;
  }) => (
    <button
      type="button"
      data-testid="mock-transfer-owner"
      onClick={() => onChange("other-team")}
    >
      Change owner
    </button>
  ),
  TeamMultiPicker: () => <div data-testid="mock-search-teams" />,
}));

jest.mock("@/components/ui/access-subject-picker", () => ({
  AccessSubjectPicker: ({
    onChange,
  }: {
    onChange: (ref: { kind: "team"; id: string }) => void;
  }) => (
    <button
      type="button"
      data-testid="mock-transfer-owner"
      onClick={() => onChange({ kind: "team", id: "other-team" })}
    >
      Change owner
    </button>
  ),
  AccessSubjectMultiPicker: () => <div data-testid="mock-search-access" />,
}));

import { IngestionSourceForm } from "../IngestionSourceForm";

beforeEach(() => {
  global.fetch = jest.fn().mockImplementation(async (url: string) => {
    if (url.includes("/api/dynamic-agents/teams")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: [
            { _id: "t1", slug: "team-example", name: "Example Team" },
            { _id: "t2", slug: "other-team", name: "Other Team" },
          ],
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  }) as unknown as typeof fetch;
});

afterEach(() => {
  jest.restoreAllMocks();
});

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

describe("<IngestionSourceForm /> — Confirm Transfer recovery", () => {
  it("surfaces an inline Confirm Transfer button and retries with confirm_not_member: true", async () => {
    const user = userEvent.setup();
    const onSave = jest
      .fn()
      .mockRejectedValueOnce(
        new RagApiError(409, "Conflict", "TRANSFER_NOT_MEMBER_UNCONFIRMED", "not a member"),
      )
      .mockResolvedValueOnce(undefined);

    render(<IngestionSourceForm open onClose={jest.fn()} onSave={onSave} initial={initial} />);

    await act(async () => {
      await user.click(screen.getByTestId("mock-transfer-owner"));
    });

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /save changes/i }));
    });

    const confirmBtn = await screen.findByRole("button", { name: /confirm transfer/i });
    expect(confirmBtn).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/not a member/i);

    await act(async () => {
      await user.click(confirmBtn);
    });

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave).toHaveBeenLastCalledWith(
      expect.objectContaining({
        owner_team_slug: "other-team",
        owner_subject: null,
        confirm_not_member: true,
      }),
    );
  });

  it("does not include owner_team_slug/confirm_not_member when no transfer is pending", async () => {
    const user = userEvent.setup();
    const onSave = jest.fn().mockResolvedValue(undefined);
    render(<IngestionSourceForm open onClose={jest.fn()} onSave={onSave} initial={initial} />);

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /save changes/i }));
    });

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const payload = onSave.mock.calls[0][0];
    expect(payload).not.toHaveProperty("owner_team_slug");
    expect(payload).not.toHaveProperty("confirm_not_member");
  });
});
