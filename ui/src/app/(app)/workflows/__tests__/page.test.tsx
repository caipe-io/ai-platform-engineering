import { render,waitFor } from "@testing-library/react";
import React from "react";

const openEditor = jest.fn();
const routerReplace = jest.fn();
let searchParams = new URLSearchParams();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: routerReplace }),
  useSearchParams: () => searchParams,
}));

jest.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: React.ReactNode }) => <button type="button">{children}</button>,
}));

jest.mock("@/components/workflows/WorkflowCanvas", () => ({
  WorkflowCanvas: () => <div>Workflow editor</div>,
}));

jest.mock("@/store/workflow-config-store", () => ({
  useWorkflowConfigStore: () => ({
    configs: [{ _id: "workflow-visible",name: "Release workflow",steps: [] }],
    editMode: null,
    selectedConfigId: null,
    closeEditor: jest.fn(),
    loadConfigs: jest.fn(),
    openEditor,
  }),
}));

jest.mock("@/store/workflow-exec-store", () => ({
  useWorkflowExecStore: () => ({ runs: [],loadRuns: jest.fn() }),
}));

import WorkflowsPage from "../page";

describe("WorkflowsPage", () => {
  beforeEach(() => {
    openEditor.mockClear();
    routerReplace.mockClear();
    searchParams = new URLSearchParams();
    global.fetch = jest.fn().mockResolvedValue({ json: async () => [] });
  });

  it("opens the workflow selected by the deep-link parameter", async () => {
    searchParams = new URLSearchParams("workflow=workflow-visible");

    render(<WorkflowsPage />);

    await waitFor(() => {
      expect(openEditor).toHaveBeenCalledWith("edit", "workflow-visible");
    });
  });
});
