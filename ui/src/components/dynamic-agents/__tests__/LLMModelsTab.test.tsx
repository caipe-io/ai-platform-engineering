import { fireEvent,render,screen } from "@testing-library/react";

import { LLMModelsTab } from "../LLMModelsTab";

const model = {
  _id: "openai/gpt-4o",
  model_id: "openai/gpt-4o",
  name: "GPT-4o",
  provider: "openai",
  description: "General-purpose model",
  config_driven: false,
};

describe("LLMModelsTab deep links", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn(async (url) => {
      const href = String(url);
      if (href === "/api/llm-models?page_size=100") {
        return {
          json: async () => ({ success: true, data: { items: [model] } }),
        } as Response;
      }
      if (href === "/api/llm-models?id=openai%2Fgpt-4o") {
        return {
          json: async () => ({ success: true, data: model }),
        } as Response;
      }
      throw new Error(`Unexpected fetch: ${href}`);
    }) as jest.Mock;
  });

  it("loads a directly linked model and reports when its editor closes", async () => {
    const onSelectedModelChange = jest.fn();

    render(
      <LLMModelsTab
        selectedModelId="openai/gpt-4o"
        onSelectedModelChange={onSelectedModelChange}
      />,
    );

    expect(await screen.findByText("Edit Model")).toBeInTheDocument();
    expect(screen.getByLabelText("Model ID")).toHaveValue("openai/gpt-4o");
    expect(global.fetch).toHaveBeenCalledWith("/api/llm-models?id=openai%2Fgpt-4o");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onSelectedModelChange).toHaveBeenCalledWith(null);
  });

  it("keeps the selected row open when the page adds the model ID to the URL", async () => {
    const onSelectedModelChange = jest.fn();
    const { rerender } = render(
      <LLMModelsTab onSelectedModelChange={onSelectedModelChange} />,
    );

    fireEvent.click(await screen.findByText("openai/gpt-4o"));

    expect(onSelectedModelChange).toHaveBeenCalledWith("openai/gpt-4o");
    expect(screen.getByLabelText("Model ID")).toHaveValue("openai/gpt-4o");

    jest.mocked(global.fetch).mockClear();
    rerender(
      <LLMModelsTab
        selectedModelId="openai/gpt-4o"
        onSelectedModelChange={onSelectedModelChange}
      />,
    );

    expect(global.fetch).not.toHaveBeenCalledWith(
      "/api/llm-models?id=openai%2Fgpt-4o",
    );
    expect(screen.getByLabelText("Model ID")).toHaveValue("openai/gpt-4o");
  });
});


it.each([false, true])("tests the edited provider when changed=%s", async changed => {
  global.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") return { ok: true, json: async () => ({ success: true, data: { success: true, category: "success", message: "Example", elapsed_ms: 1 } }) } as Response;
    if (String(url).includes("connections")) return { json: async () => ({ success: true, data: { connections: [] } }) } as Response;
    if (String(url).includes("?id=")) return { json: async () => ({ success: true, data: model }) } as Response;
    return { json: async () => ({ success: true, data: { items: [model] } }) } as Response;
  }) as jest.Mock;
  render(<LLMModelsTab selectedModelId={model._id} />);
  await screen.findByText("Edit Model");
  if (changed) fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "groq" } });
  fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
  await screen.findByText(/Connected ·/);
  const calls = jest.mocked(global.fetch).mock.calls;
  const tested = calls.find(([, init]) => init?.method === "POST")!;
  expect(JSON.parse(String(tested[1]?.body))).toEqual(changed
    ? { draft: { provider: "groq", auth_mode: "deployment", fields: {} }, upstream_model_id: model.model_id }
    : { model_id: model._id });
});
