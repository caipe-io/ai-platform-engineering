import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";

import { MiddlewarePicker } from "../MiddlewarePicker";

const definitions = [
  {
    key: "model_retry",
    label: "Model Retry",
    description: "Retries model calls",
    enabled_by_default: true,
    allow_multiple: false,
    default_params: { max_retries: 5 },
    param_schema: { max_retries: "number" },
  },
  {
    key: "context_editing",
    label: "Context Editing",
    description: "Trims old context",
    enabled_by_default: true,
    allow_multiple: false,
    default_params: { keep: 3 },
    param_schema: { keep: "number" },
  },
  {
    key: "pii",
    label: "PII Detection",
    description: "Protects sensitive data",
    enabled_by_default: false,
    allow_multiple: true,
    default_params: { pii_type: "email", strategy: "redact" },
    param_schema: {
      pii_type: "email|credit_card",
      strategy: "redact|block",
    },
  },
];

function mockDefinitions() {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, data: definitions }),
  });
}

describe("MiddlewarePicker", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDefinitions();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("always shows every middleware and reflects runtime defaults", async () => {
    render(<MiddlewarePicker value={undefined} onChange={jest.fn()} />);

    expect(await screen.findByText("Model Retry")).toBeInTheDocument();
    expect(screen.getByText("Context Editing")).toBeInTheDocument();
    expect(screen.getByText("PII Detection")).toBeInTheDocument();
    expect(screen.getByLabelText("Disable Model Retry")).toBeChecked();
    expect(screen.getByLabelText("Disable Context Editing")).toBeChecked();
    expect(screen.getByLabelText("Enable PII Detection")).not.toBeChecked();
    expect(
      screen.queryByRole("button", { name: /Add configuration/i }),
    ).not.toBeInTheDocument();
  });

  it("materializes the full stack when an off middleware is enabled", async () => {
    const onChange = jest.fn();
    render(<MiddlewarePicker value={undefined} onChange={onChange} />);

    fireEvent.click(await screen.findByLabelText("Enable PII Detection"));

    expect(onChange).toHaveBeenCalledWith({
      middleware: [
        { type: "model_retry", enabled: true, params: { max_retries: 5 } },
        { type: "context_editing", enabled: true, params: { keep: 3 } },
        {
          type: "pii",
          enabled: true,
          params: { pii_type: "email", strategy: "redact" },
        },
      ],
    });
  });

  it("shows missing middleware as off once an explicit stack exists", async () => {
    render(
      <MiddlewarePicker
        value={{
          middleware: [
            {
              type: "model_retry",
              enabled: true,
              params: { max_retries: 2 },
            },
          ],
        }}
        onChange={jest.fn()}
      />,
    );

    expect(await screen.findByLabelText("Disable Model Retry")).toBeChecked();
    expect(screen.getByLabelText("Enable Context Editing")).not.toBeChecked();
    expect(screen.getByLabelText("Enable PII Detection")).not.toBeChecked();
  });

  it("keeps contextual duplication for middleware that supports multiple rules", async () => {
    const onChange = jest.fn();
    render(<MiddlewarePicker value={undefined} onChange={onChange} />);

    const duplicate = await screen.findByRole("button", {
      name: "Add another PII Detection configuration",
    });
    fireEvent.click(duplicate);

    await waitFor(() => {
      const next = onChange.mock.calls.at(-1)?.[0];
      expect(
        next.middleware.filter(
          (entry: { type: string }) => entry.type === "pii",
        ),
      ).toHaveLength(2);
    });
  });
});
