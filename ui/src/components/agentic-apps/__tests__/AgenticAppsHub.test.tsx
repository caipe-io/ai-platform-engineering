import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AgenticAppsHub } from "../AgenticAppsHub";

const mockPush = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

function response(items: unknown[]): Promise<Response> {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ items }),
  } as Response);
}

describe("AgenticAppsHub", () => {
  beforeEach(() => {
    mockPush.mockClear();
    global.fetch = jest.fn(() => response([])) as jest.Mock;
  });

  afterEach(() => {
    jest.restoreAllMocks();
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

  it("does not show the install prompt when Weather is in the catalog", async () => {
    global.fetch = jest.fn(() => response([{
      appId: "weather",
      displayName: "Weather App",
      description: "Forecasts",
      href: "/apps/weather",
      canLaunch: true,
      blockedReasons: [],
      categories: ["weather"],
      capabilities: ["forecast"],
    }])) as jest.Mock;

    render(<AgenticAppsHub />);

    await waitFor(() => expect(screen.getByRole("link", { name: /open/i })).toBeInTheDocument());
    expect(screen.queryByText("Try the Weather App")).not.toBeInTheDocument();
  });
});
