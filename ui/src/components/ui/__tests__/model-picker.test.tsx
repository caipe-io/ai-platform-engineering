import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ModelPicker, type ModelPickerOption } from "../model-picker";

const MODELS: ModelPickerOption[] = [
  { model_id: "primary", name: "Primary model", provider: "default" },
  { model_id: "secondary", name: "Secondary model", provider: "example" },
];

it("maps the selected model identity and provider label", async () => {
  const user = userEvent.setup();
  const onChange = jest.fn();

  render(
    <ModelPicker
      options={MODELS}
      modelId="primary"
      modelProvider="default"
      onChange={onChange}
    />,
  );

  expect(screen.getByRole("combobox", { name: "LLM Model" })).toHaveTextContent(
    "Primary model",
  );
  await user.click(screen.getByRole("combobox", { name: "LLM Model" }));
  await user.click(
    screen.getByRole("option", { name: "Secondary model (example)" }),
  );

  expect(onChange).toHaveBeenCalledWith("secondary", "example");
});

it("keeps an unavailable saved model visible", () => {
  render(
    <ModelPicker
      options={MODELS}
      modelId="saved-model"
      modelProvider="saved-provider"
      onChange={jest.fn()}
    />,
  );

  expect(screen.getByRole("combobox", { name: "LLM Model" })).toHaveTextContent(
    "saved-model (saved-provider)",
  );
});

it("exposes loading and empty models as disabled states", () => {
  const { rerender } = render(
    <ModelPicker options={[]} loading onChange={jest.fn()} />,
  );

  expect(screen.getByRole("combobox", { name: "LLM Model" })).toBeDisabled();
  expect(screen.getByRole("combobox", { name: "LLM Model" })).toHaveTextContent(
    "Loading models...",
  );

  rerender(<ModelPicker options={[]} onChange={jest.fn()} />);
  expect(screen.getByRole("combobox", { name: "LLM Model" })).toBeDisabled();
  expect(screen.getByRole("combobox", { name: "LLM Model" })).toHaveTextContent(
    "No models available",
  );
});
