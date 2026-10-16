import { ephemeralFileBlob, isPreviewableEphemeralFile,PREVIEWABLE_FILE_EXTENSIONS } from "../ephemeral-files";

describe("ephemeral-files", () => {
  it("marks .md and .txt as previewable", () => {
    expect(PREVIEWABLE_FILE_EXTENSIONS).toEqual([".md", ".txt"]);
    expect(isPreviewableEphemeralFile("workflow-state/meraki-docs-networking.md")).toBe(true);
    expect(isPreviewableEphemeralFile("output.txt")).toBe(true);
    expect(isPreviewableEphemeralFile("data.json")).toBe(false);
    expect(isPreviewableEphemeralFile("archive.tar.gz")).toBe(false);
  });

  it("downloads binary records as bytes and retains legacy text", () => {
    const binary = ephemeralFileBlob({ content: "/wD+UEs=", encoding: "base64" });
    expect(binary.size).toBe(5);
    expect(binary.type).toBe("application/octet-stream");
    const text = ephemeralFileBlob({ content: "hello" });
    expect(text.size).toBe(5);
    expect(text.type).toBe("text/plain;charset=utf-8");
  });

  it.each(["!!!!", "Zg=", "Zh==", "é==="])("rejects malformed binary %s", (content) => {
    expect(() => ephemeralFileBlob({ content, encoding: "base64" })).toThrow();
  });
});
