import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgenticAppsHub } from "../AgenticAppsHub";
import type { PublicAgenticApp } from "@/types/agentic-app";

const mockRouter = { push: jest.fn() };
const mockGetSettings = jest.fn();
const mockUpdatePreferences = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => mockRouter, useSearchParams: () => new URLSearchParams(window.location.search) }));
jest.mock("@/lib/api-client", () => ({ apiClient: {
  getSettings: (...args: unknown[]) => mockGetSettings(...args),
  updatePreferences: (...args: unknown[]) => mockUpdatePreferences(...args),
} }));
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
  window.history.replaceState(null, "", "/apps");
  mockRouter.push.mockClear();
  mockGetSettings.mockReset().mockResolvedValue({ preferences: { favorite_agentic_apps: [] } });
  mockUpdatePreferences.mockReset().mockImplementation(async ({ favorite_agentic_apps }) => ({ preferences: { favorite_agentic_apps } }));
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
  expect(screen.getByText("2 apps")).toBeInTheDocument();
  expect(screen.getByText("engineering")).toHaveClass("bg-violet-700", "text-white");
});

it("persists a favorite and keeps the card launch as one accessible link", async () => {
  render(<AgenticAppsHub />);
  const favorite = await screen.findByRole("button", { name: "Add Example workspace to favorites" });
  await waitFor(() => expect(favorite).toBeEnabled());
  fireEvent.click(favorite);
  await waitFor(() => expect(mockUpdatePreferences).toHaveBeenCalledWith({ favorite_agentic_apps: ["example-app"] }));
  expect(screen.getByRole("button", { name: "Remove Example workspace from favorites" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getAllByRole("link", { name: "Example workspace" })).toHaveLength(1);
});

it("restores the favorite state and reports a failed save", async () => {
  mockGetSettings.mockResolvedValueOnce({ preferences: { favorite_agentic_apps: ["example-app"] } });
  mockUpdatePreferences.mockRejectedValueOnce(new Error("Save failed"));
  render(<AgenticAppsHub />);
  const favorite = await screen.findByRole("button", { name: "Remove Example workspace from favorites" });
  await waitFor(() => expect(favorite).toBeEnabled());
  fireEvent.click(favorite);
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not save favorites");
  expect(screen.getByRole("button", { name: "Remove Example workspace from favorites" })).toHaveAttribute("aria-pressed", "true");
});

it("still shows the catalog when preferences fail and prevents overwriting favorites", async () => {
  mockGetSettings.mockRejectedValueOnce(new Error("Unavailable"));
  render(<AgenticAppsHub />);
  expect(await screen.findByRole("link", { name: "Example workspace" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Add Example workspace to favorites" })).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("Favorites are unavailable");
});

it("renders the catalog while settings are pending and enables favorites once loaded", async () => {
  let resolveSettings!: (settings: { preferences: { favorite_agentic_apps: string[] } }) => void;
  mockGetSettings.mockReturnValueOnce(new Promise((resolve) => { resolveSettings = resolve; }));
  render(<AgenticAppsHub />);

  expect(await screen.findByRole("link", { name: "Example workspace" })).toBeInTheDocument();
  const favorite = screen.getByRole("button", { name: "Add Example workspace to favorites" });
  expect(favorite).toBeDisabled();
  fireEvent.click(favorite);
  expect(mockUpdatePreferences).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();

  await act(async () => {
    resolveSettings({ preferences: { favorite_agentic_apps: ["example-app"] } });
  });
  expect(screen.getByRole("button", { name: "Remove Example workspace from favorites" })).toBeEnabled();
});

it("uses category colors without depending on app IDs", async () => {
  jest.mocked(global.fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ items: [
    { ...apps[0], appId: "primary", categories: ["cloud"], icon: undefined },
    { ...apps[1], appId: "secondary", categories: ["weather"], icon: undefined },
  ] }) } as Response);
  render(<AgenticAppsHub />);
  expect(await screen.findByText("cloud")).toHaveClass("bg-emerald-700", "text-white");
  expect(screen.getByText("weather")).toHaveClass("bg-sky-700", "text-white");
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
  const guide = screen.getByRole("link", { name: "Build a CAIPE app (opens in a new tab)" });
  expect(guide).toHaveAttribute("href", "https://github.com/caipe-io/ai-platform-engineering/blob/main/docs/docs/features/agentic-app-manifest.md");
  expect(guide).toHaveAttribute("target", "_blank");
  expect(guide).toHaveAttribute("rel", "noopener noreferrer");
});

it.each(["unknown-icon", "constructor", "__proto__", "toString"])(
  "falls back to the generic icon for unsupported metadata %s",
  async (icon) => {
    jest.mocked(global.fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ items: [{ ...apps[0], icon }] }) } as Response);
    render(<AgenticAppsHub />);
    await screen.findByRole("link", { name: "Example workspace" });
    expect(document.querySelector("article .lucide-app-tile")).toBeInTheDocument();
  },
);

it("preserves the packaged application icon from the public catalog", async () => {
  jest.mocked(global.fetch).mockResolvedValueOnce({ ok: true, json: async () => ({
    items: [{ ...apps[0], icon: "/app-icons/example-app/logo.png" }],
  }) } as Response);
  render(<AgenticAppsHub />);
  await screen.findByRole("link", { name: "Example workspace" });
  const image = document.querySelector("article img")!;
  expect(new URL(image.getAttribute("src")!, window.location.origin).pathname).toBe("/app-icons/example-app/logo.png");
});

it("shows catalog failures without rendering launch links", async () => {
  jest.mocked(global.fetch).mockResolvedValueOnce({ ok: false, status: 503 } as Response);
  render(<AgenticAppsHub />);
  expect(await screen.findByText("Could not load Apps")).toBeInTheDocument();
  expect(screen.getByText("Apps catalog returned HTTP 503")).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Example workspace" })).not.toBeInTheDocument();
});

it("redirects expired sessions to login without launching an app", async () => {
  jest.mocked(global.fetch).mockResolvedValueOnce({ ok: false, status: 401 } as Response);
  render(<AgenticAppsHub />);
  await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith("/login?callbackUrl=%2Fapps"));
  expect(screen.queryByRole("link", { name: "Example workspace" })).not.toBeInTheDocument();
});

it("restores a bookmarked search and preserves unrelated URL state while editing", async () => {
  window.history.replaceState(null, "", "/apps?q=document-search&assistant=1#catalog");
  render(<AgenticAppsHub />);
  const input = await screen.findByRole("searchbox", { name: "Search apps" });
  expect(input).toHaveValue("document-search");
  expect(screen.getByRole("link", { name: "Example workspace" })).toBeInTheDocument();
  expect(screen.queryByText("Secondary workspace")).not.toBeInTheDocument();
  const push = jest.spyOn(window.history, "pushState");
  const replace = jest.spyOn(window.history, "replaceState");
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "research" } });
  fireEvent.change(input, { target: { value: "secondary" } });
  expect(push).toHaveBeenCalledTimes(1);
  expect(replace).toHaveBeenCalledTimes(1);
  expect(new URLSearchParams(window.location.search).get("q")).toBe("secondary");
  expect(new URLSearchParams(window.location.search).get("assistant")).toBe("1");
  expect(window.location.hash).toBe("#catalog");
  fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
  expect(new URLSearchParams(window.location.search).has("q")).toBe(false);
  push.mockRestore(); replace.mockRestore();
});

it("restores catalog results when URL state changes through Back/Forward", async () => {
  const { rerender } = render(<AgenticAppsHub />);
  await screen.findByRole("searchbox", { name: "Search apps" });
  act(() => { window.history.replaceState(null, "", "/apps?q=research"); window.dispatchEvent(new PopStateEvent("popstate")); });
  rerender(<AgenticAppsHub />);
  await waitFor(() => expect(screen.getByRole("searchbox", { name: "Search apps" })).toHaveValue("research"));
  expect(screen.queryByRole("link", { name: "Example workspace" })).not.toBeInTheDocument();
  act(() => { window.history.replaceState(null, "", "/apps?q=engineering"); window.dispatchEvent(new PopStateEvent("popstate")); });
  rerender(<AgenticAppsHub />);
  expect(await screen.findByRole("link", { name: "Example workspace" })).toBeInTheDocument();
});


it("starts a new search entry after another navigation while the input remains focused", async () => {
  const view = render(<AgenticAppsHub />);
  const input = await screen.findByRole("searchbox");
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "engineering" } });
  act(() => window.history.pushState(null, "", "/apps?q=research"));
  view.rerender(<AgenticAppsHub />);
  expect(input).toHaveValue("research");
  const push = jest.spyOn(window.history, "pushState");
  const replace = jest.spyOn(window.history, "replaceState");
  fireEvent.change(input, { target: { value: "secondary" } });
  expect(push).toHaveBeenCalledTimes(1);
  expect(replace).not.toHaveBeenCalled();
  push.mockRestore(); replace.mockRestore();
});

it("preserves the catalog fragment when its API session expires", async () => {
  window.history.replaceState(null, "", "/apps?q=example#catalog");
  jest.mocked(global.fetch).mockResolvedValueOnce({ ok: false, status: 401 } as Response);
  render(<AgenticAppsHub />);
  await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith("/login?callbackUrl=%2Fapps%3Fq%3Dexample%23catalog"));
});


it("asks before directing an administrator to install the Weather App", async () => {
  render(<AgenticAppsHub />);

  expect(await screen.findByText("Try the Weather App")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Ask to install" }));

  expect(await screen.findByRole("heading", { name: "Install the Weather App?" })).toBeInTheDocument();
  expect(screen.getByText(/will not change your deployment automatically/i)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /open install guide/i })).toHaveAttribute(
    "href",
    "https://caipe.io/docs/features/agentic-apps/",
  );
});


it("does not offer installation when the starter app is already configured", async () => {
  jest.mocked(global.fetch).mockResolvedValueOnce({ ok: true, json: async () => ({
    items: [{ ...apps[0], appId: "weather" }],
  }) } as Response);
  render(<AgenticAppsHub />);
  await screen.findByRole("link", { name: "Example workspace" });
  expect(screen.queryByText("Try the Weather App")).not.toBeInTheDocument();
});
