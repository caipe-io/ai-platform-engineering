import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { HarnessOptionsForm } from "./HarnessOptionsForm";

it("preserves numeric drafts inside nested fields and commits valid numbers on blur", () => {
  const saved = jest.fn();
  function Example() {
    const [value, setValue] = useState<Record<string, unknown>>({ nested: { amount: 2 } });
    return <HarnessOptionsForm schema={{ properties: { nested: { type: "object", properties: { amount: { type: "number", minimum: -10, maximum: 10 } } } } }} value={value} onChange={next => { saved(next); setValue(next); }} />;
  }
  render(<Example />);
  const field = screen.getByLabelText("amount");
  fireEvent.change(field, { target: { value: "-" } });
  expect(field).toHaveValue("-");
  expect(saved).not.toHaveBeenCalled();
  fireEvent.change(field, { target: { value: "-1." } });
  expect(field).toHaveValue("-1.");
  fireEvent.change(field, { target: { value: "-1.5" } });
  fireEvent.blur(field);
  expect(saved).toHaveBeenLastCalledWith({ nested: { amount: -1.5 } });
  fireEvent.change(field, { target: { value: "100" } });
  fireEvent.blur(field);
  expect(field).toHaveValue("-1.5");
});

it("clears a required numeric value so missing-field validation can reject the save", () => {
  const changed = jest.fn();
  function Example() {
    const [value, setValue] = useState<Record<string, unknown>>({ amount: 2 });
    return <HarnessOptionsForm schema={{ required: ["amount"], properties: { amount: { type: "number" } } }} value={value} onChange={next => { changed(next); setValue(next); }} />;
  }
  render(<Example />);
  const field = screen.getByLabelText("amount");
  fireEvent.change(field, { target: { value: "" } });
  fireEvent.blur(field);
  expect(changed).toHaveBeenLastCalledWith({});
  expect(field).toHaveValue("");
});
