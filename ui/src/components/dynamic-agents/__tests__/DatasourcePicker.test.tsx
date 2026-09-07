import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";

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
      onDragStart?: unknown;
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
      onDragStart: _onDragStart,
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
      _onDragStart,
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

import { DatasourcePicker } from "../DatasourcePicker";

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body };
}

function mockKnowledgeCatalog() {
  global.fetch = jest.fn(async (url: RequestInfo | URL) => {
    const href = typeof url === "string" ? url : url.toString();
    if (href.includes("/api/rag/collections")) {
      return jsonResponse({
        success: true,
        data: {
          collections: [
            {
              _id: "platform-rag",
              name: "Platform RAG",
              description: "Trusted shared knowledge",
              is_platform: true,
              source_ids: ["slack-primary"],
              _permissions: { can_read: true },
            },
          ],
        },
      }) as Response;
    }
    return jsonResponse({
      success: true,
      data: {
        datasources: [
          {
            datasource_id: "slack-primary",
            name: "Primary Slack channel with a very long descriptive name",
            source_type: "slack",
            permission: "Your access",
            document_count: 2,
            chunk_count: 6,
          },
          {
            datasource_id: "src_confluence_docs",
            name: "Documentation",
            source_type: "confluence",
            document_count: 1,
            chunk_count: 1,
          },
        ],
      },
    }) as Response;
  });
}

function dataTransfer() {
  const values = new Map<string, string>();
  return {
    effectAllowed: "none",
    dropEffect: "none",
    setData: (type: string, value: string) => values.set(type, value),
    getData: (type: string) => values.get(type) ?? "",
  };
}

describe("DatasourcePicker", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockKnowledgeCatalog();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("puts collections first and removes the redundant access badge", async () => {
    render(
      <DatasourcePicker
        ownerTeamSlug="primary"
        value={[]}
        onChange={jest.fn()}
        collectionValue={[]}
        onCollectionChange={jest.fn()}
      />,
    );

    expect(await screen.findByText("Collections")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Platform RAG/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Primary Slack/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Your access")).not.toBeInTheDocument();
  });

  it("renders branded rectangular cards with an upward hover peek", async () => {
    render(
      <DatasourcePicker
        ownerTeamSlug="primary"
        value={["slack-primary"]}
        onChange={jest.fn()}
        collectionValue={[]}
        onCollectionChange={jest.fn()}
      />,
    );

    const card = await screen.findByTestId(
      "knowledge-card-datasource-slack-primary",
    );
    const surface = card.querySelector('[data-knowledge-card-surface="true"]');
    expect(card).toHaveAttribute("data-hover-y", "-28");
    expect(card).toHaveTextContent("Slack");
    expect(card).toHaveTextContent("2 documents · 6 chunks");
    expect(card.querySelector('img[src="/slack.svg"]')).not.toBeNull();
    expect(surface).toHaveClass("h-56", "w-40", "bg-card");

    fireEvent.mouseEnter(surface!);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Primary Slack channel with a very long descriptive name",
    );
  });

  it("aggregates member datasource counts for collection cards", async () => {
    render(
      <DatasourcePicker
        ownerTeamSlug="primary"
        value={[]}
        onChange={jest.fn()}
        collectionValue={["platform-rag"]}
        onCollectionChange={jest.fn()}
      />,
    );

    const card = await screen.findByTestId(
      "knowledge-card-collection-platform-rag",
    );
    expect(card).toHaveTextContent("2 documents · 6 chunks");
  });

  it("highlights individual sources already included by a selected collection", async () => {
    const onChange = jest.fn();
    render(
      <DatasourcePicker
        ownerTeamSlug="primary"
        value={[]}
        onChange={onChange}
        collectionValue={["platform-rag"]}
        onCollectionChange={jest.fn()}
      />,
    );

    const source = await screen.findByRole("button", {
      name: /Primary Slack channel.*Included via Platform RAG/i,
    });
    expect(source).toHaveTextContent("Included via Platform RAG");
    expect(source).toHaveClass("border-slate-500/30", "bg-muted/30");
    expect(source).not.toHaveClass("opacity-70");
    expect(source).toBeEnabled();

    fireEvent.click(source);
    expect(onChange).toHaveBeenCalledWith(["slack-primary"]);
  });

  it("greys a direct source card that is also covered by a collection", async () => {
    render(
      <DatasourcePicker
        ownerTeamSlug="primary"
        value={["slack-primary"]}
        onChange={jest.fn()}
        collectionValue={["platform-rag"]}
        onCollectionChange={jest.fn()}
      />,
    );

    const card = await screen.findByTestId(
      "knowledge-card-datasource-slack-primary",
    );
    const surface = card.querySelector('[data-knowledge-card-surface="true"]');
    expect(card).toHaveTextContent("Also included via Platform RAG");
    expect(surface).toHaveClass("grayscale", "saturate-0");
    expect(surface).not.toHaveClass("opacity-70");
  });

  it("adds collections by click and datasources by dropping them into the hand", async () => {
    const onChange = jest.fn();
    const onCollectionChange = jest.fn();
    render(
      <DatasourcePicker
        ownerTeamSlug="primary"
        value={[]}
        onChange={onChange}
        collectionValue={[]}
        onCollectionChange={onCollectionChange}
      />,
    );

    const collection = await screen.findByRole("button", {
      name: /Platform RAG/i,
    });
    fireEvent.click(collection);
    expect(onCollectionChange).toHaveBeenCalledWith(["platform-rag"]);

    const source = screen.getByRole("button", { name: /Primary Slack/i });
    const hand = screen.getByLabelText("Selected agent knowledge");
    const transfer = dataTransfer();
    fireEvent.dragStart(source, { dataTransfer: transfer });
    fireEvent.dragOver(hand, { dataTransfer: transfer });
    fireEvent.drop(hand, { dataTransfer: transfer });

    expect(onChange).toHaveBeenCalledWith(["slack-primary"]);
  });

  it("defaults a new RAG-enabled agent to the readable Platform collection", async () => {
    const onCollectionChange = jest.fn();
    render(
      <DatasourcePicker
        ownerTeamSlug="primary"
        value={[]}
        onChange={jest.fn()}
        collectionValue={[]}
        onCollectionChange={onCollectionChange}
        defaultToPlatform
      />,
    );

    await waitFor(() =>
      expect(onCollectionChange).toHaveBeenCalledWith(["platform-rag"]),
    );
  });
});
