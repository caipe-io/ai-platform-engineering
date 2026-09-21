/**
 * Tests for RichCodeEditor — theme sync with next-themes and fillContainer
 * layout contract. CodeMirror is mocked to a plain textarea so the test runs
 * fast and deterministically.
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import { oneDark } from "@codemirror/theme-one-dark";

let mockResolvedTheme: string | undefined = "light";
let lastCodeMirrorProps: Record<string, unknown> = {};

jest.mock("@/components/theme-provider", () => ({
  useTheme: () => ({ resolvedTheme: mockResolvedTheme }),
}));

jest.mock("@uiw/react-codemirror", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    lastCodeMirrorProps = props;
    return (
      <div
        data-testid="codemirror-mock"
        data-height={String(props.height ?? "")}
        data-min-height={String(props.minHeight ?? "")}
        data-max-height={String(props.maxHeight ?? "")}
        data-class-name={String(props.className ?? "")}
      />
    );
  },
}));

import { RichCodeEditor } from "../RichCodeEditor";

beforeEach(() => {
  mockResolvedTheme = "light";
  lastCodeMirrorProps = {};
});

describe("RichCodeEditor — theme", () => {
  it("uses the light theme when resolvedTheme is light", () => {
    mockResolvedTheme = "light";
    render(<RichCodeEditor value="" onChange={() => {}} />);
    expect(lastCodeMirrorProps.theme).toBe("light");
  });

  it("uses the light editor theme for Legacy Light", () => {
    mockResolvedTheme = "legacy-light";
    render(<RichCodeEditor value="" onChange={() => {}} />);
    expect(lastCodeMirrorProps.theme).toBe("light");
  });

  it("uses oneDark when resolvedTheme is dark", () => {
    mockResolvedTheme = "dark";
    render(<RichCodeEditor value="" onChange={() => {}} />);
    expect(lastCodeMirrorProps.theme).toBe(oneDark);
  });

  it("uses oneDark for non-light app themes (e.g. cyberpunk)", () => {
    mockResolvedTheme = "cyberpunk";
    render(<RichCodeEditor value="" onChange={() => {}} />);
    expect(lastCodeMirrorProps.theme).toBe(oneDark);
  });
});

describe("RichCodeEditor — fillContainer layout", () => {
  it("fills the parent and scrolls inside CodeMirror when fillContainer is true", () => {
    render(
      <RichCodeEditor value="hello" onChange={() => {}} fillContainer />,
    );
    const shell = screen.getByTestId("codemirror-mock").parentElement;
    expect(shell).toHaveAttribute("data-rich-editor");
    expect(shell?.className).toMatch(/h-full/);
    expect(shell?.className).toMatch(/flex-col/);
    expect(lastCodeMirrorProps.height).toBe("100%");
    expect(lastCodeMirrorProps.minHeight).toBeUndefined();
    expect(lastCodeMirrorProps.maxHeight).toBeUndefined();
    expect(lastCodeMirrorProps.className).toBe("min-h-0 flex-1");
  });

  it("treats height='100%' like fillContainer", () => {
    render(
      <RichCodeEditor value="hello" onChange={() => {}} height="100%" />,
    );
    expect(lastCodeMirrorProps.height).toBe("100%");
    expect(lastCodeMirrorProps.minHeight).toBeUndefined();
    expect(lastCodeMirrorProps.maxHeight).toBeUndefined();
  });

  it("uses min/max height defaults when not filling the container", () => {
    render(<RichCodeEditor value="hello" onChange={() => {}} />);
    expect(lastCodeMirrorProps.height).toBeUndefined();
    expect(lastCodeMirrorProps.minHeight).toBe("240px");
    expect(lastCodeMirrorProps.maxHeight).toBe("70vh");
    expect(lastCodeMirrorProps.className).toBeUndefined();
  });
});

void React;
