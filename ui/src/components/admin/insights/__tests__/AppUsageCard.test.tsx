import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppUsageCard } from "../AppUsageCard";

describe("AppUsageCard", () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("labels aggregate counts without implying unique visitors or filter scope", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, status: 200, json: async () => ({
      success: true, data: { enabled: true, retention_days: 30, total_loads: 8, daily: [{ date: "2026-01-01", loads: 8 }] },
    }) } as Response);
    render(<AppUsageCard />);
    expect(await screen.findByText("8 loads")).toBeInTheDocument();
    expect(screen.getByText(/Not unique visitors/)).toHaveTextContent("dashboard filters do not apply");
    fireEvent.click(screen.getByText("Recorded daily counts"));
    expect(screen.getByRole("cell", { name: "2026-01-01" })).toBeVisible();
  });

  it("distinguishes disabled collection from zero recorded loads", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, data: { enabled: false } }) } as Response);
    render(<AppUsageCard />);
    expect(await screen.findByText("Aggregate usage collection is disabled.")).toBeInTheDocument();
    expect(screen.queryByText("0 loads")).not.toBeInTheDocument();
  });

  it.each([401, 403])("hides the card on server authorization denial %s", async (status) => {
    jest.spyOn(global, "fetch").mockResolvedValue({ status } as Response);
    const { container } = render(<AppUsageCard />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("reports failure without fabricating a zero and supports retry", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockRejectedValue(new Error("network"));
    render(<AppUsageCard />);
    expect(await screen.findByRole("alert")).toHaveAttribute("title", "Application load counts are unavailable.");
    expect(screen.queryByText("0 loads")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh load counts" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("bounds a hanging request and aborts on timeout", async () => {
    jest.useFakeTimers();
    const fetchMock = jest.spyOn(global, "fetch").mockReturnValue(new Promise(() => {}));
    render(<AppUsageCard />);
    await act(async () => { jest.advanceTimersByTime(10_000); });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect((fetchMock.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true);
  });
});
