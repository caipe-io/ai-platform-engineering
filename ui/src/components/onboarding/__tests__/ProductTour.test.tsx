import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { requestProductTour } from "@/lib/product-tour";
import { ProductTourGate } from "../ProductTour";

const mockPush = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

function response(data: unknown, status = 200): Promise<Response> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response);
}

function tourPayload(status = "not_started", autoStart = true) {
  return {
    success: true,
    data: {
      auto_start: autoStart,
      eligible: true,
      state: {
        version: 1,
        status,
        current_step: status === "completed" ? 5 : 1,
        run_count: status === "not_started" ? 0 : 1,
      },
    },
  };
}

describe("ProductTourGate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== "/api/onboarding/product-tour") {
        return response({ error: "Not found" }, 404);
      }
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { action: string; current_step?: number };
        return response({
          success: true,
          data: {
            state: {
              version: 1,
              status: body.action === "complete"
                ? "completed"
                : body.action === "dismiss"
                  ? "dismissed"
                  : "in_progress",
              current_step: body.current_step ?? 1,
              run_count: 1,
            },
          },
        });
      }
      return response(tourPayload());
    }) as jest.Mock;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("starts after setup, saves progress, and supports a persistent skip", async () => {
    render(<ProductTourGate />);

    expect(await screen.findByRole("heading", { name: "Your workspace is ready" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(await screen.findByRole("heading", { name: "Pick up where you left off" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /skip tour/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/onboarding/product-tour",
        expect.objectContaining({
          method: "PATCH",
          body: expect.stringContaining('"action":"dismiss"'),
        }),
      );
    });
  });

  it("replays on demand even after completion", async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return response({
          success: true,
          data: {
            state: { version: 1, status: "in_progress", current_step: 1, run_count: 2 },
          },
        });
      }
      return response(tourPayload("completed", false));
    });
    render(<ProductTourGate />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("heading", { name: "Your workspace is ready" })).not.toBeInTheDocument();

    act(() => requestProductTour(true));

    expect(await screen.findByRole("heading", { name: "Your workspace is ready" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/onboarding/product-tour",
      expect.objectContaining({
        method: "PATCH",
        body: expect.stringContaining('"action":"reset"'),
      }),
    );
  });
});
