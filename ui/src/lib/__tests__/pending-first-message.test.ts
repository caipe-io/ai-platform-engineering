import type { InputFile } from "@/lib/file-attachments";
import {
  setPendingFirstMessage,
  takePendingFirstMessage,
} from "@/lib/pending-first-message";

describe("pending first message",() => {
  it("hands text and attachments to the matching conversation once",() => {
    const files: InputFile[] = [{
      name: "example.txt",
      mime_type: "text/plain",
      data: "ZXhhbXBsZQ==",
    }];

    setPendingFirstMessage("conversation-primary","Summarize this",files);

    expect(takePendingFirstMessage("conversation-secondary")).toBeNull();
    expect(takePendingFirstMessage("conversation-primary")).toEqual({
      text: "Summarize this",
      files,
    });
    expect(takePendingFirstMessage("conversation-primary")).toBeNull();
  });
});
