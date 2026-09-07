/** @jest-environment jsdom */

import { render, waitFor } from "@testing-library/react";

const mockRouterPush = jest.fn();
const mockRouterReplace = jest.fn();
const mockRouter = { push: mockRouterPush, replace: mockRouterReplace };
const mockDeepLinkParams = new URLSearchParams(
  "q=deployment+guide&limit=5&filter.doc_type=guide",
);

jest.mock("next/navigation", () => ({
  usePathname: () => "/knowledge-bases/search",
  useRouter: () => mockRouter,
  useSearchParams: () => mockDeepLinkParams,
}));

jest.mock("@/lib/rag-api", () => ({
  getMCPTools: jest.fn().mockResolvedValue([]),
}));

jest.mock("react-markdown", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => undefined }));

const mockInvokeMCPTool = jest.fn();
jest.mock("../api", () => ({
  getMCPToolSchemas: jest.fn().mockResolvedValue({
    tools: [{
      name: "search",
      description: "Search visible knowledge",
      parameters: { properties: { filters: { type: "object" } } },
    }],
  }),
  getHealthStatus: jest.fn().mockResolvedValue({
    config: {
      search: {
        keys: ["doc_type"],
        filter_keys: [{ key: "doc_type", type: "string" }],
      },
    },
  }),
  getDataSources: jest.fn().mockResolvedValue({ datasources: [{}] }),
  invokeMCPTool: (...args: unknown[]) => mockInvokeMCPTool(...args),
}));

import SearchView from "../SearchView";

describe("SearchView deep links", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInvokeMCPTool.mockResolvedValue({ success: true, result: {} });
  });

  it("re-runs a shared search using the recipient's discovered tool", async () => {
    render(<SearchView />);

    await waitFor(() => expect(mockInvokeMCPTool).toHaveBeenCalledWith("search", {
      query: "deployment guide",
      limit: 5,
      filters: { doc_type: "guide" },
    }));
  });
});
