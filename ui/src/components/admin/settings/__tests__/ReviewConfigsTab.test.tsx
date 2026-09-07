import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { ReviewConfigsTab } from "../ReviewConfigsTab";

jest.mock("@/components/ui/toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

const replaceMock = jest.fn();
let currentSearchParams = new URLSearchParams();
jest.mock("next/navigation", () => ({
  usePathname: () => "/admin/security/ai-review",
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => currentSearchParams,
}));

const fetchMock = jest.fn();

function jsonResponse(body: unknown, init: { status?: number; statusText?: string } = {}) {
  return {
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function reviewConfig(target: string) {
  return {
    _id: target,
    target,
    label: target,
    enabled: true,
    enforcement: "informational",
    min_score: 0.85,
    grade_thresholds: { A: 0.9, B: 0.8, C: 0.7, D: 0.6 },
    model: { id: "global.anthropic.claude-sonnet-4-6", provider: "bedrock" },
    criteria: [
      {
        id: "clarity",
        name: "Clarity",
        severity: "warning",
        weight: 1,
        micro_prompt: "Is this clear?",
        expects_fix: false,
      },
    ],
    updated_at: "2026-05-19T00:00:00.000Z",
  };
}

beforeEach(() => {
  replaceMock.mockReset();
  currentSearchParams = new URLSearchParams();
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockImplementation(async (url: RequestInfo | URL) => {
    const href = typeof url === "string" ? url : url.toString();
    if (href === "/api/dynamic-agents/models") {
      return jsonResponse({
        data: [
          {
            model_id: "global.anthropic.claude-sonnet-4-6",
            name: "Claude Sonnet",
            provider: "bedrock",
          },
        ],
      });
    }
    if (href.startsWith("/api/review-configs/")) {
      return jsonResponse({
        data: reviewConfig(decodeURIComponent(href.split("/").pop() ?? "agent-system-prompt")),
      });
    }
    return jsonResponse({ error: "not found" }, { status: 404, statusText: "Not Found" });
  });
});

it("keeps the AI Review save action in the page header row", async () => {
  render(<ReviewConfigsTab />);

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/review-configs/agent-system-prompt"));

  const header = screen.getByRole("region", { name: "AI Review configurations header" });
  expect(within(header).getByRole("heading", { name: "AI Review configurations" })).toBeInTheDocument();
  expect(within(header).queryByText("Admin")).not.toBeInTheDocument();
  const save = within(header).getByRole("button", { name: "Save" });
  expect(save).toBeInTheDocument();

  // Normalized save UX: the header Save is dirty-gated, so it stays disabled
  // until the form actually diverges from the loaded config.
  const gradeA = await screen.findByLabelText("A");
  await waitFor(() => expect(save).toBeDisabled());

  // Make an edit → the form is dirty → Save enables and "Unsaved changes" shows.
  fireEvent.change(gradeA, { target: { value: "95" } });
  await waitFor(() => expect(save).not.toBeDisabled());
  expect(within(header).getByText("Unsaved changes")).toBeInTheDocument();

  fireEvent.click(save);

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/review-configs/agent-system-prompt",
      expect.objectContaining({ method: "PUT" }),
    ),
  );
});

it("writes the active target to the subtab URL param", async () => {
  render(<ReviewConfigsTab />);

  fireEvent.click(await screen.findByRole("tab", { name: "Skills" }));
  expect(replaceMock).toHaveBeenLastCalledWith("/admin/security/ai-review?subtab=skill-md", { scroll: false });

  fireEvent.click(screen.getByRole("tab", { name: "Agents" }));
  expect(replaceMock).toHaveBeenLastCalledWith("/admin/security/ai-review?subtab=agent-system-prompt", { scroll: false });
});

it("opens the target named by the subtab URL param on load", async () => {
  currentSearchParams = new URLSearchParams("subtab=skill-md");
  render(<ReviewConfigsTab />);

  expect(await screen.findByRole("tab", { name: "Skills" })).toHaveAttribute("aria-selected", "true");
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/review-configs/skill-md"));
});
