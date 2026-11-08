import { render,screen,waitFor } from "@testing-library/react";
import { MarkdownRenderer } from "../MarkdownRenderer";

jest.mock("remend", () => ({
  __esModule: true,
  default: (content: string) => content,
}), { virtual: true });

jest.mock("marked-shiki", () => ({
  __esModule: true,
  default: () => ({}),
}));

jest.mock("shiki", () => ({
  bundledLanguages: {},
  createHighlighter: jest.fn(),
}));

describe("MarkdownRenderer links", () => {
  it("colors joined agent mentions without changing code, links, emails or unknown handles", async () => {
    const { container } = render(<MarkdownRenderer
      content="Ask @reviewer and @coder. Keep `@reviewer`, [@coder](https://example.test/@coder), user@reviewer.test and @unknown unchanged."
      mentionHandles={["coder", "reviewer"]}
    />);
    await waitFor(() => expect(container.querySelectorAll("span")).toHaveLength(2));
    const mentions = Array.from(container.querySelectorAll("span"));
    expect(mentions.map(span => span.textContent)).toEqual(["@reviewer", "@coder"]);
    expect(mentions[0].className).not.toEqual(mentions[1].className);
    expect(container.querySelector("code")?.textContent).toBe("@reviewer");
    expect(screen.getByRole("link", { name: "@coder" }).querySelector("span")).toBeNull();
    expect(container.textContent).toContain("user@reviewer.test and @unknown unchanged");
  });

  it("opens external and relative links in a new tab", async () => {
    render(
      <MarkdownRenderer
        content="[External](https://example.com/docs) [Internal](/chat/example)"
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "External" })).toHaveAttribute("target", "_blank");
      expect(screen.getByRole("link", { name: "Internal" })).toHaveAttribute("target", "_blank");
    });

    for (const link of screen.getAllByRole("link")) {
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
  });
});
