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
          event.target.value ? { kind: "team", id: event.target.value } : null,
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

import { BulkEditSourcesModal } from "../BulkEditSourcesModal";

const TEAMS = [
  { slug: "owner-team", name: "Owner Team" },
  { slug: "search-team", name: "Search Team" },
];

function mockFetch({
  bulkUpdate = {
    success: true,
    data: {
      results: [
        { source_id: "source-a", status: "updated" },
        { source_id: "source-b", status: "pending_approval" },
      ],
      updated_count: 1,
      pending_approval_count: 1,
      skipped_count: 0,
    },
  },
}: { bulkUpdate?: object } = {}): void {
  global.fetch = jest.fn((url: RequestInfo | URL, init?: RequestInit) => {
    const href = String(url);
    if (href === "/api/dynamic-agents/teams") {
      return Promise.resolve({
        json: () => Promise.resolve({ success: true, data: TEAMS }),
      } as Response);
    }
    if (href === "/api/rag/sources/bulk-update" && init?.method === "POST") {
      return Promise.resolve({
        json: () => Promise.resolve(bulkUpdate),
      } as Response);
    }
    return Promise.reject(new Error(`Unexpected fetch: ${href}`));
  });
}

describe("BulkEditSourcesModal", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch();
  });

  it("renders the selected source count and disables Apply until Owner or Search Access is set", async () => {
    render(
      <BulkEditSourcesModal
        open
        sourceIds={["source-a", "source-b"]}
        onClose={jest.fn()}
        onApplied={jest.fn()}
      />,
    );

    expect(
      screen.getByText("Bulk edit 2 datasources"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("bulk-edit-submit")).toBeDisabled();
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
  });

  it("disables Apply when Set Owner is checked but no Owner is picked yet", async () => {
    render(
      <BulkEditSourcesModal
        open
        sourceIds={["source-a"]}
        onClose={jest.fn()}
        onApplied={jest.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Set Owner"));
    expect(screen.getByTestId("bulk-edit-submit")).toBeDisabled();
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
  });

  it("applies an Owner across every selected source", async () => {
    render(
      <BulkEditSourcesModal
        open
        sourceIds={["source-a", "source-b"]}
        onClose={jest.fn()}
        onApplied={jest.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Set Owner"));
    await screen.findByLabelText("Owner");
    fireEvent.change(screen.getByLabelText("Owner"), {
      target: { value: "owner-team" },
    });
    expect(screen.getByTestId("bulk-edit-submit")).not.toBeDisabled();
    fireEvent.click(screen.getByTestId("bulk-edit-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("bulk-edit-result")).toHaveTextContent(
        "Updated 1, pending approval 1, skipped 0.",
      );
    });
    const call = (global.fetch as jest.Mock).mock.calls.find(
      ([href]) => href === "/api/rag/sources/bulk-update",
    );
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      source_ids: ["source-a", "source-b"],
      owner: { team_slug: "owner-team", subject: undefined },
    });
  });

  it("applies Search Access alone, without requiring an Owner, defaulting to additive mode", async () => {
    render(
      <BulkEditSourcesModal
        open
        sourceIds={["source-a"]}
        onClose={jest.fn()}
        onApplied={jest.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Set Search Access"));
    expect(screen.getByTestId("bulk-edit-submit")).not.toBeDisabled();
    fireEvent.click(await screen.findByLabelText("Owner Team"));
    fireEvent.click(screen.getByTestId("bulk-edit-submit"));

    await waitFor(() => {
      const call = (global.fetch as jest.Mock).mock.calls.find(
        ([href]) => href === "/api/rag/sources/bulk-update",
      );
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        source_ids: ["source-a"],
        search: {
          mode: "additive",
          team_slugs: ["owner-team"],
          user_subjects: [],
        },
      });
    });
  });

  it("switches Search Access apply mode to Replace when selected", async () => {
    render(
      <BulkEditSourcesModal
        open
        sourceIds={["source-a"]}
        onClose={jest.fn()}
        onApplied={jest.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Set Search Access"));
    fireEvent.click(screen.getByRole("radio", { name: /Replace/i }));
    fireEvent.click(await screen.findByLabelText("Owner Team"));
    fireEvent.click(screen.getByTestId("bulk-edit-submit"));

    await waitFor(() => {
      const call = (global.fetch as jest.Mock).mock.calls.find(
        ([href]) => href === "/api/rag/sources/bulk-update",
      );
      expect(JSON.parse(String(call?.[1]?.body))).toEqual(
        expect.objectContaining({
          search: expect.objectContaining({ mode: "replace" }),
        }),
      );
    });
  });

  it("disables Apply for Replace mode with an empty Search Access list, since that would silently revoke everyone", async () => {
    render(
      <BulkEditSourcesModal
        open
        sourceIds={["source-a"]}
        onClose={jest.fn()}
        onApplied={jest.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Set Search Access"));
    fireEvent.click(screen.getByRole("radio", { name: /Replace/i }));
    expect(screen.getByTestId("bulk-edit-submit")).toBeDisabled();
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
  });

  it("allows Apply for Additive mode with an empty Search Access list, since that is a harmless no-op", async () => {
    render(
      <BulkEditSourcesModal
        open
        sourceIds={["source-a"]}
        onClose={jest.fn()}
        onApplied={jest.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Set Search Access"));
    // Additive is already the default mode.
    expect(screen.getByTestId("bulk-edit-submit")).not.toBeDisabled();
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
  });

  it("lists skipped sources with a human-readable reason", async () => {
    mockFetch({
      bulkUpdate: {
        success: true,
        data: {
          results: [
            { source_id: "source-a", status: "skipped", reason: "FORBIDDEN_MANAGE" },
          ],
          updated_count: 0,
          pending_approval_count: 0,
          skipped_count: 1,
        },
      },
    });
    render(
      <BulkEditSourcesModal
        open
        sourceIds={["source-a"]}
        onClose={jest.fn()}
        onApplied={jest.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Set Owner"));
    await screen.findByLabelText("Owner");
    fireEvent.change(screen.getByLabelText("Owner"), {
      target: { value: "owner-team" },
    });
    fireEvent.click(screen.getByTestId("bulk-edit-submit"));

    expect(
      await screen.findByText("source-a: you do not manage this source"),
    ).toBeInTheDocument();
  });

  it("resets all fields when reopened", async () => {
    const { rerender } = render(
      <BulkEditSourcesModal
        open
        sourceIds={["source-a"]}
        onClose={jest.fn()}
        onApplied={jest.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Set Owner"));
    await screen.findByLabelText("Owner");
    fireEvent.change(screen.getByLabelText("Owner"), {
      target: { value: "owner-team" },
    });

    rerender(
      <BulkEditSourcesModal
        open={false}
        sourceIds={["source-a"]}
        onClose={jest.fn()}
        onApplied={jest.fn()}
      />,
    );
    rerender(
      <BulkEditSourcesModal
        open
        sourceIds={["source-b"]}
        onClose={jest.fn()}
        onApplied={jest.fn()}
      />,
    );

    expect(screen.queryByLabelText("Owner")).not.toBeInTheDocument();
    expect(screen.getByTestId("bulk-edit-submit")).toBeDisabled();
  });
});
