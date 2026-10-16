import { fireEvent, render, screen } from "@testing-library/react";
import { AgenticAppsHub } from "../AgenticAppsHub";
import type { PublicAgenticApp } from "@/types/agentic-app";

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
const apps: PublicAgenticApp[] = [
  { appId: "example-app", displayName: "Example workspace", description: "Shared workspace", href: "/example",
    canLaunch: true, blockedReasons: [], categories: ["engineering"], capabilities: ["document-search"], uiMode: "native-package", icon: "sparkles" },
  { appId: "secondary", displayName: "Secondary workspace", description: "Hosted workspace", href: "/apps/secondary",
    canLaunch: false, blockedReasons: ["unauthorized"], categories: ["research"], capabilities: [], uiMode: "iframe" },
];
beforeEach(() => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ items: apps }) });
});

it("renders native and hosted catalog entries with one accessible launch link", async () => {
  render(<AgenticAppsHub />);
  const link = await screen.findByRole("link", { name: "Example workspace" });
  expect(link).toHaveAttribute("href", "/example");
  expect(screen.getAllByRole("link", { name: "Example workspace" })).toHaveLength(1);
  expect(screen.queryByRole("link", { name: "Secondary workspace" })).not.toBeInTheDocument();
  expect(screen.getByText("Access required: unauthorized")).toBeInTheDocument();
  expect(screen.getByText("2 of 2 apps")).toBeInTheDocument();
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
