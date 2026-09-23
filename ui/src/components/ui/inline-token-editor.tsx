"use client";

import { cn } from "@/lib/utils";
import { useCallback, useEffect, useRef, useState } from "react";

const CHIP_CLASS = "mx-0.5 rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary";

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches a trigger mention being typed, anchored to the caret. */
function mentionPattern(trigger: string): RegExp {
  return new RegExp(`${escapeForRegExp(trigger)}[A-Za-z0-9_]*$`);
}

export interface InlineTokenSuggestion {
  /** Text shown beside the chip in the suggestion row. */
  label: string;
  description?: string;
}

export interface InlineTokenEditorProps {
  /** Text containing `token` wherever the atomic chip belongs. */
  value: string;
  onChange: (value: string) => void;
  /** Canonical marker stored in `value` for each chip, e.g. `{{secret}}`. */
  token: string;
  /** What the chip displays in place of `token`. */
  tokenLabel: string;
  /** Offered when the trigger is typed. Omit to disable insertion. */
  suggestion?: InlineTokenSuggestion;
  /** Character that opens the insert suggestion. */
  trigger?: string;
  placeholder?: string;
  ariaLabel: string;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
}

/**
 * Reads the canonical text back out of an editor element, turning chips into
 * `token`. The DOM owns the content while editing, so this is how edits become
 * state.
 */
export function tokenTextFromElement(element: HTMLElement, token: string): string {
  let text = "";
  element.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? "";
      return;
    }
    if (node instanceof HTMLElement) {
      text += node.dataset.inlineToken ? token : (node.textContent ?? "");
    }
  });
  return text;
}

function createChip(label: string): HTMLSpanElement {
  const chip = document.createElement("span");
  // Atomic to the browser's editing model: the caret steps over it, and a
  // deletion takes the whole token rather than one character of its label.
  chip.contentEditable = "false";
  chip.dataset.inlineToken = "true";
  chip.className = CHIP_CLASS;
  chip.textContent = label;
  return chip;
}

function paint(element: HTMLElement, value: string, token: string, tokenLabel: string): void {
  element.replaceChildren();
  const segments = value.split(token);
  segments.forEach((segment, index) => {
    if (segment) element.append(document.createTextNode(segment));
    if (index < segments.length - 1) element.append(createChip(tokenLabel));
  });
}

function caretRange(): Range | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  return selection.getRangeAt(0);
}

function isChip(node: Node | null | undefined): node is HTMLElement {
  return node instanceof HTMLElement && Boolean(node.dataset.inlineToken);
}

/** The chip containing `node`, when a caret has landed inside one. */
function enclosingChip(editor: HTMLElement, node: Node | null): HTMLElement | null {
  let current: Node | null = node;
  while (current && current !== editor) {
    if (isChip(current)) return current;
    current = current.parentNode;
  }
  return null;
}

/** The chip directly before a collapsed caret, if there is one. */
function chipBeforeCaret(editor: HTMLElement, range: Range): HTMLElement | null {
  const inside = enclosingChip(editor, range.startContainer);
  if (inside) return inside;
  if (range.startContainer === editor) {
    const candidate = range.startOffset > 0 ? editor.childNodes[range.startOffset - 1] : null;
    return isChip(candidate) ? candidate : null;
  }
  if (range.startContainer.nodeType === Node.TEXT_NODE && range.startOffset === 0) {
    const candidate = range.startContainer.previousSibling;
    return isChip(candidate) ? candidate : null;
  }
  return null;
}

/** The chip directly after a collapsed caret, if there is one. */
function chipAfterCaret(editor: HTMLElement, range: Range): HTMLElement | null {
  const inside = enclosingChip(editor, range.startContainer);
  if (inside) return inside;
  if (range.startContainer === editor) {
    const candidate = editor.childNodes[range.startOffset] ?? null;
    return isChip(candidate) ? candidate : null;
  }
  if (range.startContainer.nodeType === Node.TEXT_NODE) {
    const text = range.startContainer as Text;
    if (range.startOffset === (text.textContent?.length ?? 0)) {
      return isChip(text.nextSibling) ? text.nextSibling : null;
    }
  }
  return null;
}

/** The chip a selection covers, if it covers exactly one. */
function selectedChip(editor: HTMLElement, range: Range): HTMLElement | null {
  if (range.collapsed) return null;
  if (
    range.startContainer === editor &&
    range.endContainer === editor &&
    range.endOffset - range.startOffset === 1
  ) {
    const candidate = editor.childNodes[range.startOffset] ?? null;
    if (isChip(candidate)) return candidate;
  }
  // A selectNode() on a non-editable node is often normalized into its interior,
  // so the same selection can come back anchored inside the chip instead.
  const start = enclosingChip(editor, range.startContainer);
  return start && start === enclosingChip(editor, range.endContainer) ? start : null;
}

function selectNode(node: Node): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNode(node);
  selection.removeAllRanges();
  selection.addRange(range);
}

function collapseTo(node: Node, edge: "before" | "after"): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  if (edge === "before") range.setStartBefore(node);
  else range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function placeCaretAtStart(node: Node): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.setStart(node, 0);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Single-line editor whose `token` occurrences render as atomic chips.
 *
 * Backspace beside a chip selects the whole chip first and removes it on a
 * second press, and typing `trigger` offers to insert one back.
 */
export function InlineTokenEditor({
  value,
  onChange,
  token,
  tokenLabel,
  suggestion,
  trigger = "$",
  placeholder,
  ariaLabel,
  disabled,
  invalid,
  className,
}: InlineTokenEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  // What this editor last emitted. Repainting only happens for changes that came
  // from elsewhere, because repainting mid-keystroke would drop the caret.
  const emitted = useRef<string | null>(null);
  const [suggestionOpen, setSuggestionOpen] = useState(false);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || emitted.current === value) return;
    paint(editor, value, token, tokenLabel);
    emitted.current = value;
  }, [value, token, tokenLabel]);

  const commit = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const next = tokenTextFromElement(editor, token);
    emitted.current = next;
    onChange(next);
  }, [onChange, token]);

  const textBeforeCaret = (): string => {
    const range = caretRange();
    if (!range || !range.collapsed) return "";
    if (range.startContainer.nodeType !== Node.TEXT_NODE) return "";
    return (range.startContainer.textContent ?? "").slice(0, range.startOffset);
  };

  const insertToken = useCallback(() => {
    const editor = editorRef.current;
    const range = caretRange();
    if (!editor || !range || range.startContainer.nodeType !== Node.TEXT_NODE) return;

    const textNode = range.startContainer as Text;
    const full = textNode.textContent ?? "";
    const before = full.slice(0, range.startOffset);
    const mention = mentionPattern(trigger).exec(before);
    if (!mention) return;

    const start = before.length - mention[0].length;
    textNode.textContent = before.slice(0, start) + full.slice(range.startOffset);
    const chip = createChip(tokenLabel);
    const tail = textNode.splitText(start);
    textNode.parentNode?.insertBefore(chip, tail);
    // Anchored in the trailing text node rather than at editor level, which some
    // browsers render at the end of the line instead of against the chip.
    placeCaretAtStart(tail);
    setSuggestionOpen(false);
    commit();
  }, [commit, tokenLabel, trigger]);

  const handleInput = () => {
    commit();
    setSuggestionOpen(
      Boolean(suggestion) && mentionPattern(trigger).test(textBeforeCaret()),
    );
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (suggestionOpen) insertToken();
      return;
    }
    if (suggestionOpen && (event.key === "Tab" || event.key === "ArrowDown")) {
      event.preventDefault();
      insertToken();
      return;
    }
    if (event.key === "Escape" && suggestionOpen) {
      event.preventDefault();
      setSuggestionOpen(false);
      return;
    }

    const editor = editorRef.current;
    const range = caretRange();
    if (!editor || !range) return;

    // A chip is one indivisible step for the caret: an arrow key selects it, and
    // the next press moves past it. Browsers do not agree on how to traverse a
    // non-editable inline node, so every case is handled here.
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      const forward = event.key === "ArrowRight";
      const highlighted = selectedChip(editor, range);
      if (highlighted) {
        event.preventDefault();
        collapseTo(highlighted, forward ? "after" : "before");
        return;
      }
      if (range.collapsed) {
        const chip = forward
          ? chipAfterCaret(editor, range)
          : chipBeforeCaret(editor, range);
        if (chip) {
          event.preventDefault();
          selectNode(chip);
        }
      }
      return;
    }

    if (event.key !== "Backspace" && event.key !== "Delete") return;

    // Deleting a selection is done here rather than left to the browser, which
    // may decline to remove a non-editable node — including via select-all.
    if (!range.collapsed) {
      event.preventDefault();
      range.deleteContents();
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      commit();
      return;
    }

    const chip =
      event.key === "Backspace"
        ? chipBeforeCaret(editor, range)
        : chipAfterCaret(editor, range);
    if (!chip) return;

    event.preventDefault();
    selectNode(chip);
  };

  /**
   * Keeps the caret out of a chip's interior, where typing would be ignored.
   * The edge follows the direction of travel so a leftward caret is not thrown
   * back to the right.
   */
  const normalizeCaret = (edge: "before" | "after") => {
    const editor = editorRef.current;
    const range = caretRange();
    if (!editor || !range || !range.collapsed) return;
    const inside = enclosingChip(editor, range.startContainer);
    if (inside) collapseTo(inside, edge);
  };

  const handleKeyUp = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowUp" || event.key === "Home") {
      normalizeCaret("before");
      return;
    }
    if (event.key === "ArrowRight" || event.key === "ArrowDown" || event.key === "End") {
      normalizeCaret("after");
    }
  };

  return (
    <div className="relative">
      <div
        ref={editorRef}
        role="textbox"
        aria-label={ariaLabel}
        aria-multiline={false}
        aria-invalid={invalid}
        contentEditable={!disabled}
        suppressContentEditableWarning
        data-placeholder={placeholder}
        tabIndex={disabled ? -1 : 0}
        onInput={handleInput}
        onBlur={() => setSuggestionOpen(false)}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onMouseUp={() => normalizeCaret("after")}
        onClick={() => normalizeCaret("after")}
        className={cn(
          // Deliberately normal inline flow rather than flex: a flex
          // contenteditable misplaces the caret, and `pre-wrap` is what keeps a
          // trailing space such as "Bearer " from collapsing away.
          "min-h-9 w-full whitespace-pre-wrap break-words rounded-md border border-input bg-background px-3 py-1.5 font-mono text-sm leading-6",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          "empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)]",
          disabled && "cursor-not-allowed opacity-50",
          invalid && "border-destructive",
          className,
        )}
      />
      {suggestionOpen && suggestion && (
        <ul
          role="listbox"
          aria-label={`Insert ${tokenLabel}`}
          className="absolute left-0 top-full z-20 mt-1 w-full overflow-hidden rounded-md border border-border bg-popover shadow-md"
        >
          <li>
            <button
              type="button"
              role="option"
              aria-selected
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
              onMouseDown={(event) => event.preventDefault()}
              onClick={insertToken}
            >
              <span className={CHIP_CLASS}>{tokenLabel}</span>
              <span className="truncate text-muted-foreground">
                {suggestion.description ?? suggestion.label}
              </span>
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}

export default InlineTokenEditor;
