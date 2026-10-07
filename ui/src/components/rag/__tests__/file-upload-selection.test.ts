/** @jest-environment jsdom */

import { mergeSelectedUploadFiles } from "../file-upload-selection";

const limits = {
  max_file_size_mb: 10,
  max_files_per_upload: 3,
  max_total_upload_size_mb: 20,
};

function pdf(name: string, size = 100, lastModified = 1): File {
  return new File([new Uint8Array(size)], name, {
    type: "application/pdf",
    lastModified,
  });
}

describe("mergeSelectedUploadFiles", () => {
  it("appends later drops without removing files already selected", () => {
    const first = mergeSelectedUploadFiles([], [pdf("primary.pdf")], limits);
    const second = mergeSelectedUploadFiles(first.files, [pdf("secondary.pdf")], limits);

    expect(second.files.map((file) => file.name)).toEqual([
      "primary.pdf",
      "secondary.pdf",
    ]);
  });

  it("does not add the same file twice", () => {
    const selected = pdf("primary.pdf");
    const result = mergeSelectedUploadFiles([selected], [selected], limits);

    expect(result.files).toEqual([selected]);
    expect(result.duplicateCount).toBe(1);
  });

  it("enforces the file-count limit across existing and incoming files", () => {
    const result = mergeSelectedUploadFiles(
      [pdf("primary.pdf")],
      [pdf("secondary.pdf"), pdf("tertiary.pdf"), pdf("overflow.pdf")],
      limits,
    );

    expect(result.files).toHaveLength(3);
    expect(result.countRejectedCount).toBe(1);
  });
});
