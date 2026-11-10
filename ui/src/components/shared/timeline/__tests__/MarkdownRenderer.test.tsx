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
  it.each(["ops!", "ops#", "ops%", "ops?", "ops{", "ops|", "ops~", '"ops"', '"ops! name"'])("keeps the email local part %s literal", async localPart => {
    const email = `${localPart}@reviewer.test`;
    const { container } = render(<MarkdownRenderer
      content={`Contact ${email}, then ask @reviewer.`}
      variant="user"
      mentionHandles={["reviewer"]}
    />);
    await waitFor(() => expect(container.textContent).toContain(email));
    const mentions = Array.from(container.querySelectorAll("span"));
    expect(mentions.map(span => span.textContent)).toEqual(["@reviewer"]);
    expect(container.textContent?.trim()).toBe(`Contact ${email}, then ask @reviewer.`);
  });

  it("colors a mention after punctuation when it has no email domain", async () => {
    const { container } = render(<MarkdownRenderer content="Ask!@reviewer." mentionHandles={["reviewer"]} />);
    await waitFor(() => expect(container.querySelector("span")).toHaveTextContent("@reviewer"));
  });

  it.each([undefined, []])("colors primary in a user message without joined agents (%j)", async handles => {
    const { container } = render(<MarkdownRenderer
      content="Ask @primary and @unknown."
      variant="user"
      mentionHandles={handles}
    />);
    await waitFor(() => expect(container.querySelector("span")).toHaveTextContent("@primary"));
    expect(container.querySelectorAll("span")).toHaveLength(1);
    expect(container.querySelector("span")).toHaveClass("text-blue-700");
  });

  it("leaves mentions literal outside user messages without a mention context", async () => {
    const { container } = render(<MarkdownRenderer content="Ask @primary." />);
    await waitFor(() => expect(container.textContent?.trim()).toBe("Ask @primary."));
    expect(container.querySelector("span")).toBeNull();
  });

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
