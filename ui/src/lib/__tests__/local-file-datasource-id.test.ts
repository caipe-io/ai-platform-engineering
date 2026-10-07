/** @jest-environment node */

import {
  computeLocalFileDatasourceId,
  type LocalUploadFile,
} from "@/lib/local-file-datasource-id";

function upload(name: string, content: string): LocalUploadFile {
  const bytes = new TextEncoder().encode(content);
  return {
    name,
    arrayBuffer: async () => bytes.buffer.slice(0),
  };
}

describe("computeLocalFileDatasourceId", () => {
  it("matches the RAG server id for one file", async () => {
    await expect(
      computeLocalFileDatasourceId([upload("Runbook.md", "# hello")]),
    ).resolves.toBe("src_file_runbook_e12bb20996a5");
  });

  it("includes file order and content in a batch id", async () => {
    const first = await computeLocalFileDatasourceId([
      upload("one.md", "# one"),
      upload("two.txt", "two"),
    ]);
    const same = await computeLocalFileDatasourceId([
      upload("one.md", "# one"),
      upload("two.txt", "two"),
    ]);
    const reversed = await computeLocalFileDatasourceId([
      upload("two.txt", "two"),
      upload("one.md", "# one"),
    ]);

    expect(first).toBe(same);
    expect(first).toMatch(/^src_file_one_2_files_[a-f0-9]{12}$/);
    expect(reversed).not.toBe(first);
  });

  it("uses only the basename", async () => {
    await expect(
      computeLocalFileDatasourceId([upload("folder/Runbook.md", "# hello")]),
    ).resolves.toBe("src_file_runbook_e12bb20996a5");
  });
});
