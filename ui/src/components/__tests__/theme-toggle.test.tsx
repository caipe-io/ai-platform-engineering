/**
 * Unit tests for ThemeToggle and ThemeQuickToggle components
 *
 * Tests:
 * - ThemeToggle: placeholder before mount, theme label, dropdown, theme options, checkmark,
 *   setTheme calls, close after selection, footer text, outside click
 * - ThemeQuickToggle: placeholder, sun/moon icons, toggle behavior, dark variants
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ============================================================================
// Mocks — must be before imports
// ============================================================================

let mockTheme = "dark";
let mockResolvedTheme = "dark";
const mockSetTheme = jest.fn();

jest.mock("@/components/theme-provider", () => ({
  useTheme: () => ({
    theme: mockTheme,
    setTheme: mockSetTheme,
    resolvedTheme: mockResolvedTheme,
  }),
}));

jest.mock("framer-motion", () => ({
  motion: {
    // eslint-disable-next-line react/display-name
    div: React.forwardRef(
      (
        {
          children,
          ...props
        }: { children?: React.ReactNode } & Record<string, unknown>,
        ref: React.Ref<HTMLDivElement>
      ) => (
        <div ref={ref} {...props}>
          {children}
        </div>
      )
    ),
  },
  AnimatePresence: ({ children }: { children?: React.ReactNode }) => (
    <>{children}</>
  ),
}));

jest.mock("lucide-react", () => ({
  Sun: () => <span data-testid="icon-sun">Sun</span>,
  Moon: () => <span data-testid="icon-moon">Moon</span>,
  Monitor: () => <span data-testid="icon-monitor">Monitor</span>,
  Palette: () => <span data-testid="icon-palette">Palette</span>,
  Check: () => <span data-testid="icon-check">Check</span>,
  Settings: () => <span data-testid="icon-settings">Settings</span>,
  ChevronDown: () => <span data-testid="icon-chevron">ChevronDown</span>,
}));

jest.mock("@/components/ui/button", () => ({
  // eslint-disable-next-line react/display-name
  Button: React.forwardRef(
    (
      {
        children,
        onClick,
        ...props
      }: { children?: React.ReactNode; onClick?: () => void } & Record<
        string,
        unknown
      >,
      ref: React.Ref<HTMLButtonElement>
    ) => (
      <button ref={ref} onClick={onClick} {...props}>
        {children}
      </button>
    )
  ),
}));

jest.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

// ============================================================================
// Imports — after mocks
// ============================================================================

import { ThemeToggle, ThemeQuickToggle } from "../theme-toggle";

// ============================================================================
// Tests — ThemeToggle
// ============================================================================

describe("ThemeToggle", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTheme = "dark";
    mockResolvedTheme = "dark";
  });

  it("shows current theme label after mount", async () => {
    render(<ThemeToggle />);
    await waitFor(() => {
      expect(screen.getByText("Dark")).toBeInTheDocument();
    });
  });

  it("opens dropdown on click", async () => {
    render(<ThemeToggle />);
    await waitFor(() => {
      expect(screen.getByText("Dark")).toBeInTheDocument();
    });
    const trigger = screen.getByText("Dark").closest("button");
    fireEvent.click(trigger!);
    expect(screen.getByText("Theme Settings")).toBeInTheDocument();
  });

  it("displays all 10 theme options", async () => {
    render(<ThemeToggle />);
    await waitFor(() => {
      expect(screen.getByText("Dark")).toBeInTheDocument();
    });
    const trigger = screen.getAllByText("Dark")[0].closest("button");
    fireEvent.click(trigger!);
    expect(screen.getByText("Light")).toBeInTheDocument();
    expect(screen.getByText("Legacy Light")).toBeInTheDocument();
    expect(screen.getByText("System")).toBeInTheDocument();
    expect(screen.getByText("Midnight")).toBeInTheDocument();
    expect(screen.getByText("Nord")).toBeInTheDocument();
    expect(screen.getByText("Tokyo Night")).toBeInTheDocument();
    expect(screen.getByText("Cyberpunk")).toBeInTheDocument();
    expect(screen.getByText("Tron")).toBeInTheDocument();
    expect(screen.getByText("Matrix")).toBeInTheDocument();
    expect(screen.getAllByText("Dark").length).toBeGreaterThanOrEqual(1);
  });

  it("shows checkmark on selected theme", async () => {
    render(<ThemeToggle />);
    await waitFor(() => {
      expect(screen.getByText("Dark")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Dark").closest("button")!);
    expect(screen.getByTestId("icon-check")).toBeInTheDocument();
  });

  it("clicking theme calls setTheme", async () => {
    render(<ThemeToggle />);
    await waitFor(() => {
      expect(screen.getByText("Dark")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Dark").closest("button")!);
    fireEvent.click(screen.getByText("Light"));
    expect(mockSetTheme).toHaveBeenCalledWith("light");
  });

  it("keeps the original light palette available as Legacy Light", async () => {
    render(<ThemeToggle />);
    await waitFor(() => {
      expect(screen.getByText("Dark")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Dark").closest("button")!);
    fireEvent.click(screen.getByText("Legacy Light"));
    expect(mockSetTheme).toHaveBeenCalledWith("legacy-light");
  });

  it("closes dropdown after selection", async () => {
    render(<ThemeToggle />);
    await waitFor(() => {
      expect(screen.getByText("Dark")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Dark").closest("button")!);
    fireEvent.click(screen.getByText("Light"));
    await waitFor(() => {
      expect(screen.queryByText("Theme Settings")).not.toBeInTheDocument();
    });
  });

  it("shows correct footer text for dark mode", async () => {
    mockResolvedTheme = "dark";
    render(<ThemeToggle />);
    await waitFor(() => {
      expect(screen.getByText("Dark")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Dark").closest("button")!);
    expect(screen.getByText(/Current: Dark mode/)).toBeInTheDocument();
  });

  it("shows correct footer text for light mode", async () => {
    mockResolvedTheme = "light";
    mockTheme = "light";
    render(<ThemeToggle />);
    await waitFor(() => {
      expect(screen.getByText("Light")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Light").closest("button")!);
    expect(screen.getByText(/Current: Light mode/)).toBeInTheDocument();
  });

  it("closes on outside click", async () => {
    render(
      <div>
        <ThemeToggle />
        <button data-testid="outside">Outside</button>
      </div>
    );
    await waitFor(() => {
      expect(screen.getByText("Dark")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Dark").closest("button")!);
    expect(screen.getByText("Theme Settings")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId("outside"));
    await waitFor(() => {
      expect(screen.queryByText("Theme Settings")).not.toBeInTheDocument();
    });
  });
});

// ============================================================================
// Tests — ThemeQuickToggle
// ============================================================================

describe("ThemeQuickToggle", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolvedTheme = "dark";
  });

  it("shows sun icon in dark mode", async () => {
    mockResolvedTheme = "dark";
    render(<ThemeQuickToggle />);
    await waitFor(() => {
      expect(screen.getByTestId("icon-sun")).toBeInTheDocument();
    });
  });

  it("shows moon icon in light mode", async () => {
    mockResolvedTheme = "light";
    render(<ThemeQuickToggle />);
    await waitFor(() => {
      expect(screen.getByTestId("icon-moon")).toBeInTheDocument();
    });
  });

  it("toggles to light when clicking in dark mode", async () => {
    mockResolvedTheme = "dark";
    render(<ThemeQuickToggle />);
    await waitFor(() => {
      expect(screen.getByTestId("icon-sun")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("icon-sun").closest("button")!);
    expect(mockSetTheme).toHaveBeenCalledWith("light");
  });

  it("toggles to dark when clicking in light mode", async () => {
    mockResolvedTheme = "light";
    render(<ThemeQuickToggle />);
    await waitFor(() => {
      expect(screen.getByTestId("icon-moon")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("icon-moon").closest("button")!);
    expect(mockSetTheme).toHaveBeenCalledWith("dark");
  });

  it("treats Legacy Light as a light variant", async () => {
    mockResolvedTheme = "legacy-light";
    render(<ThemeQuickToggle />);
    await waitFor(() => {
      expect(screen.getByTestId("icon-moon")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("icon-moon").closest("button")!);
    expect(mockSetTheme).toHaveBeenCalledWith("dark");
  });

  it("handles midnight as dark variant", async () => {
    mockResolvedTheme = "midnight";
    render(<ThemeQuickToggle />);
    await waitFor(() => {
      expect(screen.getByTestId("icon-sun")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("icon-sun").closest("button")!);
    expect(mockSetTheme).toHaveBeenCalledWith("light");
  });

  it("handles nord as dark variant", async () => {
    mockResolvedTheme = "nord";
    render(<ThemeQuickToggle />);
    await waitFor(() => {
      expect(screen.getByTestId("icon-sun")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("icon-sun").closest("button")!);
    expect(mockSetTheme).toHaveBeenCalledWith("light");
  });

  it("handles cyberpunk as dark variant", async () => {
    mockResolvedTheme = "cyberpunk";
    render(<ThemeQuickToggle />);
    await waitFor(() => {
      expect(screen.getByTestId("icon-sun")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("icon-sun").closest("button")!);
    expect(mockSetTheme).toHaveBeenCalledWith("light");
  });

  it("handles tron as dark variant", async () => {
    mockResolvedTheme = "tron";
    render(<ThemeQuickToggle />);
    await waitFor(() => {
      expect(screen.getByTestId("icon-sun")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("icon-sun").closest("button")!);
    expect(mockSetTheme).toHaveBeenCalledWith("light");
  });

  it("handles matrix as dark variant", async () => {
    mockResolvedTheme = "matrix";
    render(<ThemeQuickToggle />);
    await waitFor(() => {
      expect(screen.getByTestId("icon-sun")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("icon-sun").closest("button")!);
    expect(mockSetTheme).toHaveBeenCalledWith("light");
  });
});
