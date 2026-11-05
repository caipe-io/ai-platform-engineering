import { render, waitFor } from "@testing-library/react";

import { MarkdownRenderer } from "../MarkdownRenderer";

const mockHighlighter = {
  getLoadedLanguages: jest.fn((): string[] => []),
  loadLanguage: jest.fn<Promise<void>, [string]>(),
  codeToHtml: jest.fn((code: string) => `<pre><code>${code}</code></pre>`),
};

jest.mock("remend", () => ({
  __esModule: true,
  default: (content: string) => content,
}), { virtual: true });

jest.mock("shiki", () => ({
  bundledLanguages: {
    cpp: {}, "c++": {}, csharp: {}, "c#": {}, fsharp: {}, "f#": {},
    typescript: {}, javascript: {},
  },
  createHighlighter: jest.fn(async () => mockHighlighter),
}));

describe("MarkdownRenderer code languages", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHighlighter.getLoadedLanguages.mockReturnValue([]);
    mockHighlighter.loadLanguage.mockResolvedValue(undefined);
  });

  it.each([
    ["C++", "cpp"],
    ["C#", "csharp"],
    ["F#", "fsharp"],
    ["TypeScript", "typescript"],
    ["javascript", "javascript"],
    ["unknown-language", "text"],
    ["", "text"],
  ])("highlights a %s fence as %s", async (label, language) => {
    const { container } = render(
      <MarkdownRenderer content={`\`\`\`${label}\nexample source\n\`\`\``} />,
    );

    await waitFor(() => expect(container.querySelector("pre code")).toHaveTextContent("example source"));
    expect(mockHighlighter.codeToHtml).toHaveBeenCalledWith(
      "example source", { lang: language, theme: "dark-plus" },
    );
  });

  it("retains the plain-text fallback when loading a language fails", async () => {
    mockHighlighter.loadLanguage.mockRejectedValueOnce(new Error("Language unavailable"));
    const { container } = render(<MarkdownRenderer content={'```TypeScript\nexample source\n```'} />);

    await waitFor(() => expect(container.querySelector("pre code")).toHaveTextContent("example source"));
    expect(mockHighlighter.loadLanguage).toHaveBeenCalledWith("typescript");
    expect(mockHighlighter.codeToHtml).toHaveBeenCalledWith(
      "example source", { lang: "text", theme: "dark-plus" },
    );
  });

  it("defers highlighting until streaming finishes", async () => {
    const content = '```C++\nexample source\n```';
    const { container, rerender } = render(<MarkdownRenderer content={content} isStreaming />);
    await waitFor(() => expect(container.querySelector("pre code")).toHaveTextContent("example source"));
    expect(mockHighlighter.codeToHtml).not.toHaveBeenCalled();

    rerender(<MarkdownRenderer content={content} isStreaming={false} />);
    await waitFor(() => expect(mockHighlighter.codeToHtml).toHaveBeenCalledWith(
      "example source", { lang: "cpp", theme: "dark-plus" },
    ));
  });
});
