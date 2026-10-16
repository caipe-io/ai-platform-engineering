import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgenticAppsHub } from "../AgenticAppsHub";
import type { PublicAgenticApp } from "@/types/agentic-app";

const mockRouter = { push: jest.fn() };
jest.mock("next/navigation", () => ({ useRouter: () => mockRouter }));
jest.mock("@/components/layout/NavigationProgressLink", () => ({
  NavigationProgressLink: (props: React.ComponentProps<"a">) => <a {...props} data-client-navigation="true" />,
}));
const apps: PublicAgenticApp[] = [
  { appId: "example-app", displayName: "Example workspace", description: "Shared workspace", href: "/example",
    canLaunch: true, blockedReasons: [], categories: ["engineering"], capabilities: ["document-search"], uiMode: "native-package", icon: "sparkles" },
  { appId: "secondary", displayName: "Secondary workspace", description: "Hosted workspace", href: "/apps/secondary",
    canLaunch: false, blockedReasons: ["unauthorized"], categories: ["research"], capabilities: [], uiMode: "iframe" },
];
beforeEach(() => {
  mockRouter.push.mockClear();
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ items: apps }) });
});

it("renders native and hosted catalog entries with one accessible launch link", async () => {
  render(<AgenticAppsHub />);
  const link = await screen.findByRole("link", { name: "Example workspace" });
  expect(link).toHaveAttribute("href", "/example");
  expect(link).toHaveAttribute("data-client-navigation", "true");
  expect(screen.getAllByRole("link", { name: "Example workspace" })).toHaveLength(1);
  expect(screen.queryByRole("link", { name: "Secondary workspace" })).not.toBeInTheDocument();
  expect(screen.getByText("Access required: unauthorized")).toBeInTheDocument();
  expect(screen.getByText("2 of 2 apps")).toBeInTheDocument();
});

it("keeps hosted launch links on the document-navigation gateway path", async () => {
  jest.mocked(global.fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ items: [{ ...apps[1], canLaunch: true, blockedReasons: [] }] }) } as Response);
  render(<AgenticAppsHub />);
  const link = await screen.findByRole("link", { name: "Secondary workspace" });
  expect(link).toHaveAttribute("href", "/apps/secondary");
  expect(link).not.toHaveAttribute("data-client-navigation");
});

it("searches multiple terms across names, IDs, categories and capabilities", async () => {
  render(<AgenticAppsHub />);
  await screen.findByText("Example workspace");
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "ENGINEERING document search" } });
  expect(screen.getByText("Example workspace")).toBeInTheDocument();
  expect(screen.queryByText("Secondary workspace")).not.toBeInTheDocument();
  expect(screen.getByText("1 of 2 apps")).toBeInTheDocument();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "not-present" } });
  expect(screen.getByText(/No Apps match/)).toBeInTheDocument();
});

it("renders an empty installation without manufacturing app entries", async () => {
  jest.mocked(global.fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ items: [] }) } as Response);
  render(<AgenticAppsHub />);
  expect(await screen.findByText("No Apps are configured")).toBeInTheDocument();
  expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
});

it.each(["unknown-icon", "constructor", "__proto__", "toString"])(
  "falls back to the generic icon for unsupported metadata %s",
  async (icon) => {
    jest.mocked(global.fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ items: [{ ...apps[0], icon }] }) } as Response);
    render(<AgenticAppsHub />);
    await screen.findByRole("link", { name: "Example workspace" });
    expect(document.querySelector("article .lucide-layout-grid")).toBeInTheDocument();
  },
);

it("shows catalog failures without rendering launch links", async () => {
  jest.mocked(global.fetch).mockResolvedValueOnce({ ok: false, status: 503 } as Response);
  render(<AgenticAppsHub />);
  expect(await screen.findByText("Could not load Apps")).toBeInTheDocument();
  expect(screen.getByText("Apps catalog returned HTTP 503")).toBeInTheDocument();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});

it("redirects expired sessions to login without launching an app", async () => {
  jest.mocked(global.fetch).mockResolvedValueOnce({ ok: false, status: 401 } as Response);
  render(<AgenticAppsHub />);
  await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith("/login?callbackUrl=%2F"));
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});
