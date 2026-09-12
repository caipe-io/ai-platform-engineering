import { render, screen } from "@testing-library/react";

import { AgenticAppShell } from "../AgenticAppShell";

jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

describe("AgenticAppShell", () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          {
            appId: "example-app",
            displayName: "Example App",
            canLaunch: true,
          },
        ],
      }),
    }) as jest.Mock;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("renders the app without a second breadcrumb row", async () => {
    render(<AgenticAppShell appId="example-app" path={[]} />);

    expect(await screen.findByTitle("Example App")).toHaveAttribute(
      "src",
      "/apps/example-app",
    );
    expect(screen.queryByRole("link", { name: "Apps" })).not.toBeInTheDocument();
  });
});
