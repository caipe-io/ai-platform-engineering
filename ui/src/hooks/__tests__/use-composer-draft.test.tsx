import { StrictMode, useRef, useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useComposerDraft } from "../use-composer-draft";
import type { AssistantDraft } from "@/lib/agentic-apps/assistant-draft";

function Composer({ draft, enabled = true, onApplied }: { draft: AssistantDraft | null; enabled?: boolean; onApplied: (id: string) => void }) {
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useComposerDraft({ draft, enabled, setInput, inputRef, onApplied });
  return <form onSubmit={(event) => { event.preventDefault(); throw new Error("Must not submit automatically"); }}><textarea ref={inputRef} aria-label="Message" value={input} onChange={(event) => setInput(event.target.value)} /></form>;
}

it("waits for readiness, preserves existing text, focuses, and applies once in StrictMode", async () => {
  const draft = { id: "draft-1", text: "Find the source for example-worker." };
  const applied = jest.fn();
  const view = render(<StrictMode><Composer draft={draft} enabled={false} onApplied={applied} /></StrictMode>);
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "My existing question" } });
  expect(applied).not.toHaveBeenCalled();
  view.rerender(<StrictMode><Composer draft={draft} enabled onApplied={applied} /></StrictMode>);
  await waitFor(() => expect(screen.getByLabelText("Message")).toHaveValue("My existing question\n\n" + draft.text));
  expect(screen.getByLabelText("Message")).toHaveFocus();
  expect(applied).toHaveBeenCalledTimes(1);
  view.rerender(<StrictMode><Composer draft={{ ...draft }} enabled onApplied={applied} /></StrictMode>);
  await act(async () => {});
  expect(applied).toHaveBeenCalledTimes(1);
});

it("allows a new explicit draft but ignores invalid drafts", async () => {
  const applied = jest.fn();
  const view = render(<Composer draft={{ id: "one", text: "First question" }} onApplied={applied} />);
  await waitFor(() => expect(applied).toHaveBeenCalledWith("one"));
  view.rerender(<Composer draft={{ id: "two", text: "Second question" }} onApplied={applied} />);
  await waitFor(() => expect(screen.getByLabelText("Message")).toHaveValue("First question\n\nSecond question"));
  view.rerender(<Composer draft={{ id: "bad", text: "x".repeat(12001) }} onApplied={applied} />);
  await act(async () => {});
  expect(applied).toHaveBeenCalledTimes(2);
  view.unmount();
});

it("does not apply or acknowledge a draft after unmount", async () => {
  const applied = jest.fn();
  const view = render(<Composer draft={{ id: "cancelled", text: "Pending question" }} onApplied={applied} />);
  view.unmount();
  await act(async () => {});
  expect(applied).not.toHaveBeenCalled();
});
