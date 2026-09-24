import { attachScreenshotToJiraIssue, createJiraTicket } from "@/lib/jira-ticket";

describe("jira-ticket", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  describe("createJiraTicket", () => {
    it("maps issueType Bug to the ITSM '[System] Problem' type", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: "10001", key: "EXAMPLE-1" }),
      }) as unknown as typeof fetch;

      await createJiraTicket(
        "https://jira.example.com",
        "example-bot@example.com",
        "token",
        "EXAMPLE",
        {
          description: "Broken button",
          userEmail: "user@example.com",
          contextUrl: "https://example.test",
          area: "Chat",
          issueType: "Bug",
        },
      );

      const [, options] = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.fields.issuetype.name).toBe("[System] Problem");
    });

    it("maps issueType Enhancement to Task", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: "10002", key: "EXAMPLE-2" }),
      }) as unknown as typeof fetch;

      await createJiraTicket(
        "https://jira.example.com",
        "example-bot@example.com",
        "token",
        "EXAMPLE",
        {
          description: "Add dark mode",
          userEmail: "user@example.com",
          contextUrl: "https://example.test",
          area: "Chat",
          issueType: "Enhancement",
        },
      );

      const [, options] = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.fields.issuetype.name).toBe("Task");
    });

    it("throws with the Jira error message on failure", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ errors: { issuetype: "Specify a valid issue type" } }),
      }) as unknown as typeof fetch;

      await expect(
        createJiraTicket("https://jira.example.com", "example-bot@example.com", "token", "EXAMPLE", {
          description: "x",
          userEmail: "user@example.com",
          contextUrl: "https://example.test",
          area: "Chat",
        }),
      ).rejects.toThrow("Specify a valid issue type");
    });
  });

  describe("attachScreenshotToJiraIssue", () => {
    const pngDataUrl = `data:image/png;base64,${Buffer.from("fake-png-bytes").toString("base64")}`;

    it("uploads the decoded screenshot as a multipart attachment", async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;

      await attachScreenshotToJiraIssue(
        "https://jira.example.com",
        "example-bot@example.com",
        "token",
        "EXAMPLE-42",
        pngDataUrl,
      );

      expect(global.fetch).toHaveBeenCalledWith(
        "https://jira.example.com/rest/api/3/issue/EXAMPLE-42/attachments",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ "X-Atlassian-Token": "no-check" }),
        }),
      );
      const [, options] = (global.fetch as jest.Mock).mock.calls[0];
      expect(options.body).toBeInstanceOf(FormData);
    });

    it("throws on a non-data URL", async () => {
      await expect(
        attachScreenshotToJiraIssue(
          "https://jira.example.com",
          "example-bot@example.com",
          "token",
          "EXAMPLE-42",
          "not-a-data-url",
        ),
      ).rejects.toThrow("not a valid base64 data URL");
    });

    it("throws with the response body on a failed upload", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 413,
        text: async () => "Attachment too large",
      }) as unknown as typeof fetch;

      await expect(
        attachScreenshotToJiraIssue(
          "https://jira.example.com",
          "example-bot@example.com",
          "token",
          "EXAMPLE-42",
          pngDataUrl,
        ),
      ).rejects.toThrow("Jira attachment upload failed (413)");
    });
  });
});
