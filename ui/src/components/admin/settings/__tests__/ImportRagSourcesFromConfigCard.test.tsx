/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";

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

const COLLECTIONS = [
  {
    _id: "platform-rag",
    name: "Platform RAG",
    description: "Shared knowledge",
    is_platform: true,
    source_ids: [],
    maintainer_team_slugs: ["owner-team"],
    reader_team_slugs: ["reader-team"],
    global_read: false,
    created_by: "platform",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    _permissions: {
      can_read: true,
      can_publish: true,
      can_manage: true,
      can_delegate: true,
    },
  },
  {
    _id: "primary-collection",
    name: "Primary Collection",
    description: "Team knowledge",
    is_platform: false,
    source_ids: [],
    maintainer_team_slugs: ["primary-team"],
    reader_team_slugs: ["primary-team"],
    global_read: false,
    created_by: "admin-sub",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    _permissions: {
      can_read: true,
      can_publish: true,
      can_manage: true,
      can_delegate: true,
    },
  },
];

function mockFetch({
  preview = {
    success: true,
    data: {
      sources: PREVIEW_SOURCES,
      configured_source_count: 3,
      destination_collection: {
        id: "platform-rag",
        source_count: 0,
      },
    },
  },
  apply = {
    success: true,
    data: {
      sources: PREVIEW_SOURCES,
      adopted: ["slack-channel-C1"],
      skipped: [],
      configured_source_count: 3,
      destination_collection: {
        id: "platform-rag",
        source_count: 2,
      },
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
    if (href === "/api/rag/collections") {
      return Promise.resolve({
        json: () =>
          Promise.resolve({ success: true, data: { collections: COLLECTIONS } }),
      } as Response);
    }
    if (href === "/api/dynamic-agents/teams") {
      return Promise.resolve({
        json: () =>
          Promise.resolve({
            success: true,
            data: [
              { slug: "owner-team", name: "Owner Team" },
              { slug: "reader-team", name: "Reader Team" },
              { slug: "primary-team", name: "Primary Team" },
            ],
          }),
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
    expect(screen.getByLabelText("Destination collection")).toHaveTextContent(
      "Platform RAG",
    );
    expect(screen.getByText("Owner:").closest("p")).toHaveTextContent(
      "Owner: Owner Team · Search: Reader Team",
    );
  });

  it("adopts only selected app-config source ids", async () => {
    render(<ImportRagSourcesFromConfigCard isAdmin />);
    fireEvent.click(screen.getByTestId("import-rag-sources-from-config-button"));

    await screen.findByTestId("import-rag-source-checkbox-slack-channel-C1");
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
        destination_collection_id: "platform-rag",
      }),
    );
  });

  it("adopts into another collection when selected", async () => {
    render(<ImportRagSourcesFromConfigCard isAdmin />);
    fireEvent.click(screen.getByTestId("import-rag-sources-from-config-button"));

    const destination = await screen.findByLabelText("Destination collection");
    fireEvent.click(destination);
    fireEvent.click(
      await screen.findByRole("option", { name: "Primary Collection" }),
    );
    expect(screen.getByText("Owner:").closest("p")).toHaveTextContent(
      "Owner: Primary Team · Search: Primary Team",
    );

    fireEvent.click(screen.getByTestId("import-rag-sources-apply-button"));
    await waitFor(() => {
      const applyCall = (global.fetch as jest.Mock).mock.calls.find(([, init]) => {
        if (!init?.body) return false;
        return JSON.parse(String(init.body)).dry_run === false;
      });
      expect(JSON.parse(String(applyCall?.[1]?.body))).toEqual(
        expect.objectContaining({
          destination_collection_id: "primary-collection",
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
          destination_collection: { id: "platform-rag", source_count: 1 },
        },
      },
    });
    render(<ImportRagSourcesFromConfigCard isAdmin />);
    fireEvent.click(screen.getByTestId("import-rag-sources-from-config-button"));

    await screen.findByTestId("import-rag-source-checkbox-slack-channel-C1");
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
