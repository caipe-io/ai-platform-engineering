import { act, fireEvent, render, screen } from "@testing-library/react";
import { Share2 } from "lucide-react";

import { CopyButton } from "../copy-button";

describe("CopyButton icon selection", () => {
  const writeText = jest.fn<Promise<void>, [string]>();
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const secureContextDescriptor = Object.getOwnPropertyDescriptor(window, "isSecureContext");

  beforeEach(() => {
    jest.useFakeTimers();
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    else Reflect.deleteProperty(navigator, "clipboard");
    if (secureContextDescriptor) Object.defineProperty(window, "isSecureContext", secureContextDescriptor);
    else Reflect.deleteProperty(window, "isSecureContext");
  });

  it("retains the default copy icon", () => {
    const { container } = render(<CopyButton value="example" />);
    expect(container.querySelector(".lucide-copy")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy" })).toBeEnabled();
  });

  it("uses a custom idle icon and restores it after success", async () => {
    const { container } = render(
      <CopyButton value="https://example.test/item" icon={Share2} label="Copy link" />,
    );
    expect(container.querySelector(".lucide-share-2")).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy link" })); });
    expect(writeText).toHaveBeenCalledWith("https://example.test/item");
    expect(container.querySelector(".lucide-check")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
    act(() => { jest.advanceTimersByTime(1800); });
    expect(container.querySelector(".lucide-share-2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy link" })).toBeEnabled();
  });

  it("does not copy when disabled", () => {
    render(<CopyButton value="example" icon={Share2} disabled />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).not.toHaveBeenCalled();
  });
});
