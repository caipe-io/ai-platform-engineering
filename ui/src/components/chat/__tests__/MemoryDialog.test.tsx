import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { MemoryDialog, type MemoryFile, memoryEntryCount } from "../MemoryDialog";

const existingFile: MemoryFile = {
  path: "/memories/global/AGENTS.md",
  text: "<!-- caipe-memory:file v=1 scope=global -->\n## Preferred greeting\nmarker\n\nStart with Hello.\n",
  etag: "etag-old",
  scope: "global",
  records: [{
    memory_id: "mem_0123456789abcdefghij",
    title: "Preferred greeting",
    value: "Start with Hello.",
    source: "agent",
    created_at: "2026-08-06T00:00:00Z",
    updated_at: "2026-08-06T00:00:00Z",
  }],
  char_count: 100,
  max_chars: 8000,
  over_budget: false,
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("memoryEntryCount", () => {
  afterEach(() => jest.restoreAllMocks());

  it("counts injected freeform preamble even before canonical repair", () => {
    expect(memoryEntryCount({
      records: [],
      preamble: 'Always start with "Howdy" when replying.',
    })).toBe(1);
  });

  it("does not count blank preamble", () => {
    expect(memoryEntryCount({ records: [], preamble: "  \n" })).toBe(0);
  });

  it("edits one record through PATCH without exposing raw Markdown", async () => {
    const updatedFile = {
      ...existingFile,
      etag: "etag-new",
      records: [{
        ...existingFile.records[0],
        title: "Greeting style",
        value: "Start with Howdy.",
      }],
    };
    const fetchMock = jest.spyOn(global, "fetch")
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { files: [existingFile], max_file_chars: 8000 },
      }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { file: updatedFile },
      }));

    render(
      <MemoryDialog
        open
        onOpenChange={jest.fn()}
        focusIds={[]}
        agentId="agent-a"
      />,
    );

    await screen.findByText("Preferred greeting");
    expect(screen.getByText("Added by agent")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    fireEvent.change(screen.getByLabelText("Memory title"), { target: { value: "Greeting style" } });
    fireEvent.change(screen.getByLabelText("Memory body"), { target: { value: "Start with Howdy." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, request] = fetchMock.mock.calls[1];
    expect(request).toEqual(expect.objectContaining({ method: "PATCH" }));
    expect(JSON.parse(String((request as RequestInit).body))).toEqual({
      path: existingFile.path,
      memory_id: existingFile.records[0].memory_id,
      title: "Greeting style",
      body: "Start with Howdy.",
      etag: "etag-old",
    });
  });

  it("shows AGENTS.md as read-only source", async () => {
    jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse({
      success: true,
      data: { files: [existingFile], max_file_chars: 8000 },
    }));

    render(
      <MemoryDialog
        open
        onOpenChange={jest.fn()}
        focusIds={[]}
        agentId="agent-a"
      />,
    );

    await screen.findByText("Preferred greeting");
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    const source = screen.getByLabelText("AGENTS.md source") as HTMLTextAreaElement;
    expect(source.readOnly).toBe(true);
    expect(source.value).toBe(existingFile.text);
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Preview" })).not.toBeInTheDocument();
  });
});
