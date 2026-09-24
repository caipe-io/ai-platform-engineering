/**
 * @jest-environment jsdom
 */

import { act, render, screen } from "@testing-library/react";
import { useState } from "react";

import { InlineTokenEditor, tokenTextFromElement } from "../inline-token-editor";

const TOKEN = "{{secret}}";

function Harness({ initial = "Bearer {{secret}}" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <InlineTokenEditor
        ariaLabel="Value template"
        value={value}
        onChange={setValue}
        token={TOKEN}
        tokenLabel="$DOCS_TOKEN"
        suggestion={{ label: "$DOCS_TOKEN", description: "Docs site token" }}
        placeholder="Bearer "
      />
      <output data-testid="value">{value}</output>
    </>
  );
}

function editor(): HTMLElement {
  return screen.getByLabelText("Value template");
}

/**
 * Replaces the content and leaves the caret at the end, which is what the editor
 * reads to decide whether a trigger was just typed.
 */
async function editTo(text: string): Promise<void> {
  const element = editor();
  await act(async () => {
    element.textContent = text;
    const textNode = element.firstChild;
    if (textNode) {
      const range = document.createRange();
      range.setStart(textNode, textNode.textContent?.length ?? 0);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("tokenTextFromElement", () => {
  it("turns token chips back into the canonical marker", () => {
    const host = document.createElement("div");
    host.append(document.createTextNode("Bearer "));
    const chip = document.createElement("span");
    chip.dataset.inlineToken = "true";
    chip.textContent = "$DOCS_TOKEN";
    host.append(chip);
    host.append(document.createTextNode("!"));

    expect(tokenTextFromElement(host, TOKEN)).toBe("Bearer {{secret}}!");
  });

  it("keeps the text of elements that are not chips", () => {
    const host = document.createElement("div");
    const span = document.createElement("span");
    span.textContent = "plain";
    host.append(span);

    expect(tokenTextFromElement(host, TOKEN)).toBe("plain");
  });

  it("reads an empty editor as an empty string", () => {
    expect(tokenTextFromElement(document.createElement("div"), TOKEN)).toBe("");
  });
});

describe("<InlineTokenEditor />", () => {
  it("renders the token as a labelled chip rather than the raw marker", () => {
    render(<Harness />);

    expect(editor()).toHaveTextContent("Bearer $DOCS_TOKEN");
    expect(editor().textContent).not.toContain(TOKEN);
    expect(screen.getByTestId("value")).toHaveTextContent("Bearer {{secret}}");
  });

  it("renders multiple occurrences of the token", () => {
    render(<Harness initial="{{secret}}:{{secret}}" />);

    expect(editor().querySelectorAll("[data-inline-token]")).toHaveLength(2);
  });

  it("reports edits using the canonical marker", async () => {
    render(<Harness />);
    await editTo("Token ");

    expect(screen.getByTestId("value")).toHaveTextContent("Token");
    expect(screen.getByTestId("value").textContent).not.toContain(TOKEN);
  });

  it("offers the suggestion once the trigger is typed", async () => {
    render(<Harness />);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    await editTo("Bearer $");

    expect(screen.getByRole("listbox", { name: /insert/i })).toBeInTheDocument();
    expect(screen.getByRole("option")).toHaveTextContent("Docs site token");
  });

  it("does not offer a suggestion when the trigger is absent", async () => {
    render(<Harness />);
    await editTo("Bearer ");

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("withholds the suggestion when no suggestion is configured", async () => {
    function NoSuggestion() {
      const [value, setValue] = useState("Bearer ");
      return (
        <InlineTokenEditor
          ariaLabel="Value template"
          value={value}
          onChange={setValue}
          token={TOKEN}
          tokenLabel="$DOCS_TOKEN"
        />
      );
    }
    render(<NoSuggestion />);
    await editTo("Bearer $");

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  describe("treats a chip as one caret step", () => {
    function chip(): HTMLElement {
      const found = editor().querySelector("[data-inline-token]");
      if (!(found instanceof HTMLElement)) throw new Error("no chip rendered");
      return found;
    }

    function putCaret(node: Node, edge: "before" | "after"): void {
      const range = document.createRange();
      if (edge === "before") range.setStartBefore(node);
      else range.setStartAfter(node);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }

    function press(key: string): void {
      act(() => {
        editor().dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
        );
      });
    }

    function selectionWrapsChip(): boolean {
      const range = window.getSelection()?.getRangeAt(0);
      if (!range || range.collapsed) return false;
      return range.startContainer === editor() && range.endOffset - range.startOffset === 1;
    }

    it("selects the chip on the first arrow press and steps past it on the second", () => {
      render(<Harness />);
      putCaret(chip(), "before");

      press("ArrowRight");
      expect(selectionWrapsChip()).toBe(true);

      press("ArrowRight");
      const range = window.getSelection()?.getRangeAt(0);
      expect(range?.collapsed).toBe(true);
      // Past the chip rather than back inside it.
      expect(chip().contains(range?.startContainer ?? null)).toBe(false);
    });

    it("selects the chip travelling left as well", () => {
      render(<Harness />);
      putCaret(chip(), "after");

      press("ArrowLeft");
      expect(selectionWrapsChip()).toBe(true);
    });

    it("steps out to the left of a chip whose selection was normalized inside it", () => {
      render(<Harness />);
      // Browsers commonly re-anchor a selectNode() on a non-editable node into
      // its interior; moving left from there must leave the chip, not enter it.
      const inner = chip().firstChild as Node;
      const range = document.createRange();
      range.setStart(inner, 0);
      range.setEnd(inner, inner.textContent?.length ?? 0);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);

      press("ArrowLeft");

      const settled = window.getSelection()?.getRangeAt(0);
      expect(settled?.collapsed).toBe(true);
      expect(chip().contains(settled?.startContainer ?? null)).toBe(false);
      // Before the chip, so the next press continues leftwards through "Bearer ".
      expect(settled?.startContainer).toBe(editor());
      expect(settled?.startOffset).toBe(1);
    });

    it("selects on the first backspace and deletes on the second", () => {
      render(<Harness />);
      putCaret(chip(), "after");

      press("Backspace");
      expect(selectionWrapsChip()).toBe(true);
      expect(screen.getByTestId("value")).toHaveTextContent("Bearer {{secret}}");

      press("Backspace");
      expect(editor().querySelector("[data-inline-token]")).toBeNull();
      expect(screen.getByTestId("value").textContent).not.toContain(TOKEN);
    });

    it("deletes everything when the whole value is selected", () => {
      render(<Harness />);
      const range = document.createRange();
      range.selectNodeContents(editor());
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);

      press("Backspace");

      expect(editor().querySelector("[data-inline-token]")).toBeNull();
      expect(screen.getByTestId("value").textContent).toBe("");
    });

    it("moves a caret placed inside the chip to just after it", () => {
      render(<Harness />);
      const inner = chip().firstChild;
      expect(inner).not.toBeNull();
      const range = document.createRange();
      range.setStart(inner as Node, 1);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);

      act(() => {
        editor().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      const settled = window.getSelection()?.getRangeAt(0);
      expect(chip().contains(settled?.startContainer ?? null)).toBe(false);
    });
  });

  it("is not editable when disabled", () => {
    render(
      <InlineTokenEditor
        ariaLabel="Value template"
        value="Bearer {{secret}}"
        onChange={jest.fn()}
        token={TOKEN}
        tokenLabel="$DOCS_TOKEN"
        disabled
      />,
    );

    expect(editor()).toHaveAttribute("contenteditable", "false");
    expect(editor()).toHaveAttribute("tabindex", "-1");
  });

  it("marks itself invalid for assistive technology", () => {
    render(
      <InlineTokenEditor
        ariaLabel="Value template"
        value="Bearer "
        onChange={jest.fn()}
        token={TOKEN}
        tokenLabel="$DOCS_TOKEN"
        invalid
      />,
    );

    expect(editor()).toHaveAttribute("aria-invalid", "true");
  });
});
