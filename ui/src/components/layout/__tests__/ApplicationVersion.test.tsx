/** @jest-environment jsdom */

import { render,screen } from "@testing-library/react";

const mockUseVersion = jest.fn();
jest.mock("@/hooks/use-version",() => ({ useVersion: () => mockUseVersion() }));

import { ApplicationVersion } from "@/components/layout/ApplicationVersion";

beforeEach(() => {
  jest.clearAllMocks();
});

it("shows the deployed version as non-clickable text in the expanded sidebar",() => {
  mockUseVersion.mockReturnValue({
    isLoading: false,
    versionInfo: { version: "0.5.67",gitCommit: "abc123",buildDate: "2026-08-20" },
  });

  render(<ApplicationVersion />);

  const identifier = screen.getByLabelText("Version: v0.5.67");
  expect(identifier).toHaveTextContent("Version: v0.5.67");
  expect(identifier.closest("a")).toBeNull();
});

it("keeps the collapsed footer accessible without showing version text",() => {
  mockUseVersion.mockReturnValue({
    isLoading: false,
    versionInfo: { version: "0.5.67" },
  });

  render(<ApplicationVersion collapsed />);

  expect(screen.getByLabelText("Version: v0.5.67")).toHaveAttribute("tabindex","0");
  expect(screen.queryByText("Version: v0.5.67")).not.toBeInTheDocument();
});

it("uses the commit SHA instead of prefixing a non-semantic version",() => {
  mockUseVersion.mockReturnValue({
    isLoading: false,
    versionInfo: { version: "preview",packageVersion: "0.2.0",gitCommit: "6c5c6617a" },
  });

  render(<ApplicationVersion />);

  expect(screen.getByText("Version: 6c5c661")).toBeInTheDocument();
  expect(screen.queryByText("vpreview")).not.toBeInTheDocument();
  expect(
    screen.getByLabelText("Version: 6c5c661"),
  ).not.toHaveAttribute("href");
});

it("shows the same build information without health or navigation for every user",() => {
  mockUseVersion.mockReturnValue({
    isLoading: false,
    versionInfo: { version: "preview",packageVersion: "0.2.0",gitCommit: "6c5c6617a" },
  });

  render(<ApplicationVersion />);

  const identifier = screen.getByTestId("application-version");
  expect(identifier).toHaveTextContent("6c5c661");
  expect(identifier.closest("a")).toBeNull();
  expect(identifier).toHaveAccessibleName("Version: 6c5c661");
});

it("keeps the collapsed build identifier non-clickable and accessible",() => {
  mockUseVersion.mockReturnValue({
    isLoading: false,
    versionInfo: { version: "0.5.67",gitCommit: "abc123456" },
  });

  render(<ApplicationVersion collapsed />);

  const identifier = screen.getByLabelText("Version: v0.5.67");
  expect(identifier).toHaveAttribute("tabindex","0");
  expect(identifier.closest("a")).toBeNull();
  expect(screen.queryByText("v0.5.67")).not.toBeInTheDocument();
});
