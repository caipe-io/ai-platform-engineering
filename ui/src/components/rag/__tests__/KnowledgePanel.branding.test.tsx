import { render, screen } from "@testing-library/react";
import { KnowledgePanel } from "../KnowledgePanel";

let mockLogoUrl = "/example-logo.svg";
let mockLogoStyle: "default" | "white" = "default";

jest.mock("@/hooks/use-rag-health", () => ({
  useRAGHealth: () => ({ status: "checking", graphRagEnabled: false, checkNow: jest.fn() }),
}));
jest.mock("@/lib/config", () => ({
  ...jest.requireActual("@/lib/config"),
  config: {
    appName: "Example workspace",
    get logoUrl() { return mockLogoUrl; },
    get logoStyle() { return mockLogoStyle; },
  },
}));
jest.mock("../GraphView", () => ({ __esModule: true, default: () => null }));
jest.mock("../IngestView", () => ({ __esModule: true, default: () => null }));
jest.mock("../SearchView", () => ({ __esModule: true, default: () => null }));

beforeEach(() => {
  mockLogoUrl = "/example-logo.svg";
  mockLogoStyle = "default";
});

it("uses the configured loading logo and application name", () => {
  render(<KnowledgePanel />);
  const logo = screen.getByRole("img", { name: "Example workspace" });
  expect(logo).toHaveAttribute("src", "/example-logo.svg");
  expect(logo).toHaveAttribute("width", "40");
  expect(logo).toHaveAttribute("height", "40");
});

it("loads an operator-configured external logo without the image optimizer", () => {
  mockLogoUrl = "https://assets.example.com/brand.png";
  render(<KnowledgePanel />);
  expect(screen.getByRole("img")).toHaveAttribute("src", mockLogoUrl);
});

it.each(["default", "white"] as const)("matches the shared %s logo filter", (style) => {
  mockLogoStyle = style;
  render(<KnowledgePanel />);
  const logo = screen.getByRole("img");
  if (style === "white") expect(logo).toHaveClass("brightness-0", "invert");
  else expect(logo).not.toHaveClass("brightness-0");
  expect(screen.getByText("Connecting to RAG server...")).toBeInTheDocument();
});
