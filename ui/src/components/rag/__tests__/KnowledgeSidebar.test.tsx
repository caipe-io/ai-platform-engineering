/**
 * Knowledge Base section navigation tests.
 *
 * Stable destinations stay visible while access data loads. Graph is omitted
 * when the feature is unavailable, matching the application's other
 * feature-gated navigation instead of rendering a dead control.
 */

import { fireEvent, render, screen } from "@testing-library/react";

let mockPathname = "/knowledge-bases/search";
jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock("lucide-react", () => ({
  Database: (p: unknown) => <svg data-testid="icon-database" {...p} />,
  Search: (p: unknown) => <svg data-testid="icon-search" {...p} />,
  GitFork: (p: unknown) => <svg data-testid="icon-gitfork" {...p} />,
  Layers3: (p: unknown) => <svg data-testid="icon-layers" {...p} />,
  ChevronDown: (p: unknown) => <svg data-testid="icon-chev-down" {...p} />,
  PanelLeft: (p: unknown) => <svg data-testid="icon-panel-left" {...p} />,
  PanelLeftClose: (p: unknown) => <svg data-testid="icon-panel-left-close" {...p} />,
  PanelLeftOpen: (p: unknown) => <svg data-testid="icon-panel-left-open" {...p} />,
  Wrench: (p: unknown) => <svg data-testid="icon-wrench" {...p} />,
  Lock: (p: unknown) => <svg data-testid="icon-lock" {...p} />,
  ShieldQuestion: (p: unknown) => <svg data-testid="icon-shieldq" {...p} />,
}));

jest.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

jest.mock("@/components/ui/button", () => ({
  Button: ({ children, ...rest }: unknown) => <button {...rest}>{children}</button>,
}));

const mockUseKbTabGates = jest.fn();
jest.mock("@/hooks/use-kb-tab-gates", () => ({
  useKbTabGates: () => mockUseKbTabGates(),
}));

import { KnowledgeSidebar } from "../KnowledgeSidebar";
import { useUnsavedChangesStore } from "@/store/unsaved-changes-store";

function setGates(gates: {
  search?: boolean;
  collections?: boolean;
  data_sources?: boolean;
  graph?: boolean;
  mcp_tools?: boolean;
  has_any_kb?: boolean;
  kb_count?: number;
  can_ingest?: boolean;
  can_search?: boolean;
  loading?: boolean;
  orgAdminBypass?: boolean;
}) {
  mockUseKbTabGates.mockReturnValue({
    gates: {
      search: gates.search ?? false,
      collections: gates.collections ?? false,
      data_sources: gates.data_sources ?? false,
      graph: gates.graph ?? false,
      mcp_tools: gates.mcp_tools ?? false,
      has_any_kb: gates.has_any_kb ?? false,
      kb_count: gates.kb_count ?? 0,
      can_ingest: gates.can_ingest ?? false,
      can_search: gates.can_search ?? false,
    },
    loading: gates.loading ?? false,
    error: null,
    orgAdminBypass: gates.orgAdminBypass ?? false,
    visibleTabs: [],
    refresh: jest.fn(),
  });
}

describe("<KnowledgeSidebar />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPathname = "/knowledge-bases/search";
    useUnsavedChangesStore.setState({
      hasUnsavedChanges: false,
      pendingNavigationHref: null,
      pendingDeferredAction: null,
    });
  });

  it("guards sidebar navigation while a collection has unsaved changes", () => {
    mockPathname = "/knowledge-bases/collections";
    useUnsavedChangesStore.getState().setUnsaved(true);
    setGates({
      search: true,
      collections: true,
      data_sources: true,
      graph: true,
      mcp_tools: true,
      has_any_kb: true,
    });
    render(<KnowledgeSidebar graphRagEnabled={true} />);

    fireEvent.click(screen.getByTestId("kb-link-/knowledge-bases/search"));

    expect(
      useUnsavedChangesStore.getState().pendingNavigationHref,
    ).toBe("/knowledge-bases/search");
  });

  it("renders every enabled destination for an org admin", () => {
    setGates({
      search: true,
      collections: true,
      data_sources: true,
      graph: true,
      mcp_tools: true,
      has_any_kb: true,
      kb_count: -1,
      orgAdminBypass: true,
    });
    render(<KnowledgeSidebar graphRagEnabled={true} />);

    expect(screen.getByTestId("kb-link-/knowledge-bases/search")).toBeInTheDocument();
    expect(screen.getByTestId("kb-link-/knowledge-bases/ingest")).toBeInTheDocument();
    expect(screen.getByTestId("kb-link-/knowledge-bases/collections")).toBeInTheDocument();
    expect(screen.getByTestId("kb-link-/knowledge-bases/graph")).toBeInTheDocument();
    expect(screen.getByTestId("kb-link-/knowledge-bases/mcp-tools")).toBeInTheDocument();
    expect(screen.queryByTestId("kb-sidebar-no-access-banner")).not.toBeInTheDocument();

    const links = screen.getAllByRole("link");
    expect(links[1]).toHaveAttribute("href", "/knowledge-bases/ingest");
    expect(links[2]).toHaveAttribute("href", "/knowledge-bases/collections");
  });

  it("keeps stable destinations available while explaining an empty grant set", () => {
    setGates({
      has_any_kb: false,
      kb_count: 0,
      orgAdminBypass: false,
    });
    render(<KnowledgeSidebar graphRagEnabled={true} />);

    expect(screen.getByTestId("kb-sidebar-no-access-banner")).toHaveClass(
      "bg-card",
      "text-foreground",
    );
    expect(screen.getByTestId("kb-sidebar-no-access-banner")).toHaveTextContent(
      "Ask an admin to grant your team permission to create data sources or search sources shared with your team.",
    );
    expect(screen.getByTestId("kb-link-/knowledge-bases/search")).toHaveAttribute(
      "href",
      "/knowledge-bases/search",
    );
    expect(screen.getByTestId("kb-link-/knowledge-bases/ingest")).toBeInTheDocument();
    expect(screen.getByTestId("kb-link-/knowledge-bases/collections")).toBeInTheDocument();
    expect(screen.getByTestId("kb-link-/knowledge-bases/graph")).toBeInTheDocument();
    expect(screen.getByTestId("kb-link-/knowledge-bases/mcp-tools")).toBeInTheDocument();
  });

  it("suppresses the share prompt when an explicit capability was granted", () => {
    setGates({
      search: true,
      collections: true,
      data_sources: true,
      mcp_tools: true,
      has_any_kb: false,
      can_ingest: true,
      can_search: true,
    });
    render(<KnowledgeSidebar graphRagEnabled={true} />);

    expect(screen.queryByTestId("kb-sidebar-no-access-banner")).not.toBeInTheDocument();
    expect(screen.getByTestId("kb-link-/knowledge-bases/search")).toBeInTheDocument();
    expect(screen.getByTestId("kb-link-/knowledge-bases/ingest")).toBeInTheDocument();
    expect(screen.getByTestId("kb-link-/knowledge-bases/collections")).toBeInTheDocument();
    expect(screen.getByTestId("kb-link-/knowledge-bases/mcp-tools")).toBeInTheDocument();
    expect(screen.getByTestId("kb-link-/knowledge-bases/graph")).toBeInTheDocument();
  });

  it("shows stable destinations when at least one knowledge base is readable", () => {
    setGates({ has_any_kb: true, kb_count: 2 });
    render(<KnowledgeSidebar graphRagEnabled={true} />);

    expect(screen.queryByTestId("kb-sidebar-no-access-banner")).not.toBeInTheDocument();
    expect(screen.getByTestId("kb-link-/knowledge-bases/search")).toBeInTheDocument();
    expect(screen.getByTestId("kb-link-/knowledge-bases/ingest")).toBeInTheDocument();
    expect(screen.getByTestId("kb-link-/knowledge-bases/collections")).toBeInTheDocument();
    expect(screen.getByTestId("kb-link-/knowledge-bases/graph")).toBeInTheDocument();
    expect(screen.getByTestId("kb-link-/knowledge-bases/mcp-tools")).toBeInTheDocument();
  });

  it("omits Graph when Graph RAG is unavailable", () => {
    setGates({ has_any_kb: true, kb_count: 1 });
    render(<KnowledgeSidebar graphRagEnabled={false} />);

    expect(screen.queryByTestId("kb-link-/knowledge-bases/graph")).not.toBeInTheDocument();
    expect(screen.queryByText("Graph", { exact: true })).not.toBeInTheDocument();
  });

  it("does not make the navigation flicker while access data loads", () => {
    setGates({ has_any_kb: true, kb_count: 1, loading: true });
    render(<KnowledgeSidebar graphRagEnabled={true} />);

    expect(screen.getByTestId("kb-link-/knowledge-bases/search")).toBeInTheDocument();
    expect(screen.getByTestId("kb-link-/knowledge-bases/ingest")).toBeInTheDocument();
    expect(screen.getByTestId("kb-link-/knowledge-bases/collections")).toBeInTheDocument();
    expect(screen.queryByTestId("kb-sidebar-no-access-banner")).not.toBeInTheDocument();
  });

  it("uses the page-style navigation without a collapse control", () => {
    setGates({ has_any_kb: false });
    render(<KnowledgeSidebar graphRagEnabled={true} />);
    expect(screen.getByTestId("kb-sidebar-no-access-banner")).toBeInTheDocument();
    expect(screen.queryByRole("button",{ name: /knowledge base navigation/i })).not.toBeInTheDocument();
  });
});
