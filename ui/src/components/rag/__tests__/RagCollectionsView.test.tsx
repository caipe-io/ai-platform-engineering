import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";

const mockReplace = jest.fn();
const mockToast = jest.fn();
let mockSearchParams = new URLSearchParams("collection=primary-collection");

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => mockSearchParams,
}));

jest.mock("@/components/ui/toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

jest.mock("framer-motion", () => {
  const ReactModule = jest.requireActual<typeof React>("react");
  const MotionDiv = ReactModule.forwardRef<
    HTMLDivElement,
    React.HTMLAttributes<HTMLDivElement> & {
      children?: React.ReactNode;
      whileHover?: { y?: number };
      whileDrag?: unknown;
      initial?: unknown;
      animate?: unknown;
      exit?: unknown;
      transition?: unknown;
      layout?: unknown;
      drag?: unknown;
      dragMomentum?: unknown;
      dragSnapToOrigin?: unknown;
      onDragEnd?: unknown;
    }
  >(({ children, whileHover, ...props }, ref) => {
    const {
      whileDrag: _whileDrag,
      initial: _initial,
      animate: _animate,
      exit: _exit,
      transition: _transition,
      layout: _layout,
      drag: _drag,
      dragMomentum: _dragMomentum,
      dragSnapToOrigin: _dragSnapToOrigin,
      onDragEnd: _onDragEnd,
      ...domProps
    } = props;
    void [
      _whileDrag,
      _initial,
      _animate,
      _exit,
      _transition,
      _layout,
      _drag,
      _dragMomentum,
      _dragSnapToOrigin,
      _onDragEnd,
    ];
    return (
      <div ref={ref} data-hover-y={whileHover?.y} {...domProps}>
        {children}
      </div>
    );
  });
  MotionDiv.displayName = "MotionDiv";
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => (
      <>{children}</>
    ),
    motion: { div: MotionDiv },
  };
});

import { RagCollectionsView } from "../RagCollectionsView";
import { useUnsavedChangesStore } from "@/store/unsaved-changes-store";

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

describe("RagCollectionsView", () => {
  let createdCollection = false;

  beforeEach(() => {
    jest.clearAllMocks();
    createdCollection = false;
    mockSearchParams = new URLSearchParams("collection=primary-collection");
    useUnsavedChangesStore.setState({
      hasUnsavedChanges: false,
      pendingNavigationHref: null,
      pendingDeferredAction: null,
    });
    global.fetch = jest.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        const href = String(url);
        if (href === "/api/rag/collections" && init?.method === "POST") {
          createdCollection = true;
          return jsonResponse({
            success: true,
            data: { _id: "new-collection" },
          });
        }
        if (
          href === "/api/rag/collections/new-collection" &&
          init?.method === "PATCH"
        ) {
          return jsonResponse({
            success: true,
            data: { _id: "new-collection" },
          });
        }
        if (
          href === "/api/rag/collections/primary-collection" &&
          init?.method === "DELETE"
        ) {
          return jsonResponse({ success: true, data: { deleted: true } });
        }
        if (href === "/api/rag/collections") {
          return jsonResponse({
            success: true,
            data: {
              collections: [
                {
                  _id: "primary-collection",
                  name: "Primary collection",
                  description: "Shared operational knowledge",
                  is_platform: false,
                  source_ids: ["slack-channel-C00000000"],
                  owner_subject: "owner-subject",
                  maintainer_team_slugs: [],
                  reader_team_slugs: [],
                  global_read: false,
                  created_by: "owner-subject",
                  created_at: "2026-08-06T00:00:00.000Z",
                  updated_at: "2026-08-06T00:00:00.000Z",
                  _permissions: {
                    can_read: true,
                    can_publish: true,
                    can_manage: true,
                    can_delegate: false,
                  },
                },
                {
                  _id: "platform-rag",
                  name: "Platform RAG",
                  description: "Shared organization knowledge",
                  is_platform: true,
                  source_ids: [],
                  maintainer_team_slugs: ["super-admins"],
                  reader_team_slugs: ["everyone"],
                  global_read: false,
                  created_by: "platform",
                  created_at: "2026-08-06T00:00:00.000Z",
                  updated_at: "2026-08-06T00:00:00.000Z",
                  _permissions: {
                    can_read: true,
                    can_publish: false,
                    can_manage: false,
                    can_delegate: false,
                  },
                },
                ...(createdCollection
                  ? [
                      {
                        _id: "new-collection",
                        name: "New collection",
                        description: "New description",
                        is_platform: false,
                        source_ids: ["web-docs"],
                        owner_subject: "owner-subject",
                        maintainer_team_slugs: [],
                        reader_team_slugs: [],
                        global_read: false,
                        created_by: "owner-subject",
                        created_at: "2026-08-07T00:00:00.000Z",
                        updated_at: "2026-08-07T00:00:00.000Z",
                        _permissions: {
                          can_read: true,
                          can_publish: true,
                          can_manage: true,
                          can_delegate: false,
                        },
                      },
                    ]
                  : []),
              ],
            },
          });
        }
        if (href === "/api/dynamic-agents/datasources?purpose=publish") {
          return jsonResponse({
            success: true,
            data: {
              datasources: [
                {
                  datasource_id: "slack-channel-C00000000",
                  name: "Slack: #primary",
                  source_type: "slack",
                  document_count: 3,
                  chunk_count: 8,
                  can_manage: false,
                  can_read: true,
                },
                {
                  datasource_id: "web-docs",
                  name: "Web docs",
                  source_type: "web",
                  document_count: 4,
                  chunk_count: 12,
                  can_manage: true,
                  can_read: true,
                },
                {
                  datasource_id: "managed-only",
                  name: "Managed only",
                  source_type: "jira",
                  can_manage: true,
                  can_read: false,
                },
              ],
            },
          });
        }
        if (href === "/api/dynamic-agents/teams") {
          return jsonResponse({ success: true, data: [] });
        }
        throw new Error(`Unexpected fetch: ${href}`);
      },
    );
  });

  it("marks Platform RAG as a built-in collection", async () => {
    render(<RagCollectionsView />);

    expect(
      await screen.findByLabelText(
        "Built-in collection for shared organization knowledge.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps the detail pane closed until a collection is selected", async () => {
    mockSearchParams = new URLSearchParams();
    render(<RagCollectionsView />);

    expect(
      await screen.findByText("Select or create a RAG collection."),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("knowledge-card-datasource-slack-channel-C00000000"),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /Primary collection/i }),
    );

    expect(
      await screen.findByDisplayValue("Primary collection"),
    ).toBeInTheDocument();
    expect(mockReplace).toHaveBeenCalledWith(
      "/knowledge-bases/collections?collection=primary-collection",
      { scroll: false },
    );
  });

  it("shows the collection id next to its name, like the agent editor does", async () => {
    render(<RagCollectionsView />);

    expect(
      await screen.findByDisplayValue("Primary collection"),
    ).toBeInTheDocument();
    expect(screen.getByText(/^id:/)).toBeInTheDocument();
    expect(screen.getByText("primary-collection")).toBeInTheDocument();
  });

  it("does not show an id for an unsaved, in-progress collection draft", async () => {
    render(<RagCollectionsView />);

    fireEvent.click(
      await screen.findByRole("button", { name: "New Collection" }),
    );

    expect(screen.getByTestId("new-collection-draft")).toBeInTheDocument();
    expect(screen.queryByText(/^id:/)).not.toBeInTheDocument();
  });

  it("opens new collection as a full inline editor", async () => {
    render(<RagCollectionsView />);

    fireEvent.click(
      await screen.findByRole("button", { name: "New Collection" }),
    );
    expect(screen.getByTestId("new-collection-draft")).toHaveTextContent(
      "New Collection",
    );
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Incident response" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Runbooks and service notes" },
    });
    expect(screen.getByTestId("new-collection-draft")).toHaveTextContent(
      "Incident response",
    );
    expect(screen.getByTestId("new-collection-draft")).toHaveTextContent(
      "Runbooks and service notes",
    );
    expect(
      screen.getByText(
        "Private by default. You are the Owner and the only person who can search this collection until you add teams below.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("You (personal)")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Search teams" })).toHaveTextContent(
      "Only you can search — add teams",
    );
    expect(screen.getByText("Datasources")).toBeInTheDocument();
    expect(screen.getByText("Access")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mockReplace).toHaveBeenCalledWith(
      "/knowledge-bases/collections?new=1",
      { scroll: false },
    );
  });

  it("restores the new collection editor from its deep link", async () => {
    mockSearchParams = new URLSearchParams("new=1");

    render(<RagCollectionsView />);

    expect(await screen.findByTestId("new-collection-draft")).toHaveTextContent(
      "New Collection",
    );
    expect(screen.getByLabelText("Name")).toHaveValue("");
  });

  it("creates a collection with its selected datasources in one save flow", async () => {
    render(<RagCollectionsView />);

    fireEvent.click(
      await screen.findByRole("button", { name: "New Collection" }),
    );
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "New collection" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "New description" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Web docs/i }));
    fireEvent.click(screen.getByRole("button", { name: "Create collection" }));

    await waitFor(() => {
      const calls = (global.fetch as jest.Mock).mock.calls;
      expect(
        calls.some(
          ([url, init]) =>
            url === "/api/rag/collections" && init?.method === "POST",
        ),
      ).toBe(true);
      const updateCall = calls.find(
        ([url, init]) =>
          url === "/api/rag/collections/new-collection" &&
          init?.method === "PATCH",
      );
      expect(JSON.parse(String(updateCall?.[1]?.body))).toEqual(
        expect.objectContaining({ source_ids: ["web-docs"] }),
      );
    });
  });

  it("asks before discarding an unsaved collection draft", async () => {
    render(<RagCollectionsView />);

    fireEvent.click(
      await screen.findByRole("button", { name: "New Collection" }),
    );
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Unsaved collection" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Primary collection/i }),
    );

    expect(
      await screen.findByText("Unsaved collection changes"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("new-collection-draft")).toHaveTextContent(
      "Unsaved collection",
    );

    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));

    expect(
      await screen.findByDisplayValue("Primary collection"),
    ).toBeInTheDocument();
  });

  it("confirms that deleting a collection leaves its data unchanged", async () => {
    jest.spyOn(window, "confirm").mockReturnValue(true);
    render(<RagCollectionsView />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Delete collection" }),
    );

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        "Collection deleted. Datasources and indexed content remain unchanged.",
        "success",
      ),
    );
  });

  it("reuses datasource cards and compact rows while preserving publish gates", async () => {
    render(<RagCollectionsView />);

    expect(
      await screen.findByText(
        "Collections group datasources so they can be assigned and managed together.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/wholesale stale-chunk replacement/i),
    ).not.toBeInTheDocument();

    const selected = await screen.findByTestId(
      "knowledge-card-datasource-slack-channel-C00000000",
    );
    expect(selected).toHaveTextContent("Slack: #primary");
    expect(selected).toHaveTextContent("3 documents · 8 chunks");
    expect(selected.querySelector('img[src="/slack.svg"]')).not.toBeNull();
    expect(
      selected.querySelector('[data-knowledge-card-surface="true"]'),
    ).not.toHaveAttribute("data-rarity");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();

    const managedOnly = screen.getByRole("button", { name: /Managed only/i });
    expect(managedOnly).toBeDisabled();
    expect(managedOnly).toHaveAttribute(
      "title",
      "A personal collection can only include datasources you can already search",
    );

    fireEvent.click(screen.getByRole("button", { name: /Web docs/i }));
    expect(
      await screen.findByTestId("knowledge-card-datasource-web-docs"),
    ).toHaveTextContent("4 documents · 12 chunks");

    fireEvent.click(
      screen.getByRole("button", { name: "Remove Slack: #primary" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByTestId(
          "knowledge-card-datasource-slack-channel-C00000000",
        ),
      ).not.toBeInTheDocument(),
    );
  });
});
