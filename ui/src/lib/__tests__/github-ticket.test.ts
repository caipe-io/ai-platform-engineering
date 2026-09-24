const mockReposGet = jest.fn();
const mockGetBranch = jest.fn();
const mockCreateOrUpdateFileContents = jest.fn();
const mockGetRef = jest.fn();
const mockCreateRef = jest.fn();

jest.mock("@octokit/rest", () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    repos: {
      get: (...args: unknown[]) => mockReposGet(...args),
      getBranch: (...args: unknown[]) => mockGetBranch(...args),
      createOrUpdateFileContents: (...args: unknown[]) => mockCreateOrUpdateFileContents(...args),
    },
    git: {
      getRef: (...args: unknown[]) => mockGetRef(...args),
      createRef: (...args: unknown[]) => mockCreateRef(...args),
    },
  })),
}));

import {
  buildGitHubIssueBody,
  parseGitHubRepo,
  titleFor,
  uploadScreenshotToGitHub,
  type GitHubTicketInput,
} from "@/lib/github-ticket";

describe("github-ticket", () => {
  const baseInput: GitHubTicketInput = {
    description: "The ingest button does nothing when clicked.",
    userEmail: "test-user@example.com",
    contextUrl: "https://example.test/projects/example",
    source: "header",
    label: "platform-reported",
    area: "Knowledge",
    issueType: "Bug",
  };

  it("parseGitHubRepo splits owner/repo", () => {
    expect(parseGitHubRepo("example-org/example-repo")).toEqual({
      owner: "example-org",
      repo: "example-repo",
    });
  });

  it("buildGitHubIssueBody includes generic report context", () => {
    const body = buildGitHubIssueBody(baseInput);
    expect(body).toContain("## Area");
    expect(body).toContain("Knowledge");
    expect(body).toContain("## Issue Type");
    expect(body).toContain("Bug");
    expect(body).toContain("test-user@example.com");
  });

  it("titleFor includes the configured area and issue type", () => {
    expect(titleFor({ ...baseInput, source: "header", area: "Chat" })).toMatch(
      /^\[Platform Report\] \[Chat\] \[Bug\]:/
    );
  });

  it("includes chat feedback block when provided", () => {
    const body = buildGitHubIssueBody({
      ...baseInput,
      source: "chat-feedback",
      feedbackContext: {
        feedbackType: "dislike",
        reason: "Trust",
        additionalFeedback: "Sources look outdated",
      },
    });
    expect(body).toContain("## Chat feedback");
    expect(body).toContain("Trust");
    expect(body).toContain("Sources look outdated");
  });

  it("embeds a real image when screenshotUrl is set", () => {
    const body = buildGitHubIssueBody({
      ...baseInput,
      screenshotUrl: "https://raw.githubusercontent.com/org/screenshots/main/screenshots/2026-07-25/abc.png",
    });
    expect(body).toContain("![Screenshot](https://raw.githubusercontent.com/org/screenshots/main/screenshots/2026-07-25/abc.png)");
  });

  it("falls back to a text note when only screenshotDataUrl is set (upload failed or not configured)", () => {
    const body = buildGitHubIssueBody({
      ...baseInput,
      screenshotDataUrl: `data:image/png;base64,${Buffer.from("x").toString("base64")}`,
    });
    expect(body).toContain("could not be uploaded");
    expect(body).not.toContain("![Screenshot]");
  });

  describe("uploadScreenshotToGitHub", () => {
    const pngDataUrl = `data:image/png;base64,${Buffer.from("fake-png-bytes").toString("base64")}`;

    beforeEach(() => {
      mockReposGet.mockReset();
      mockGetBranch.mockReset();
      mockCreateOrUpdateFileContents.mockReset();
      mockGetRef.mockReset();
      mockCreateRef.mockReset();
    });

    it("commits to the dedicated 'screenshots' branch (not the default branch) and returns its raw URL", async () => {
      mockGetBranch.mockResolvedValue({ data: { name: "screenshots" } });
      mockCreateOrUpdateFileContents.mockResolvedValue({});

      const url = await uploadScreenshotToGitHub("org/screenshots", "token", pngDataUrl);

      expect(mockCreateOrUpdateFileContents).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "org",
          repo: "screenshots",
          branch: "screenshots",
          content: Buffer.from("fake-png-bytes").toString("base64"),
        }),
      );
      expect(url).toMatch(/^https:\/\/raw\.githubusercontent\.com\/org\/screenshots\/screenshots\//);
    });

    it("bootstraps the 'screenshots' branch from the default branch when it doesn't exist yet", async () => {
      mockGetBranch.mockRejectedValue({ status: 404 });
      mockReposGet.mockResolvedValue({ data: { default_branch: "main" } });
      mockGetRef.mockResolvedValue({ data: { object: { sha: "abc123" } } });
      mockCreateRef.mockResolvedValue({});
      mockCreateOrUpdateFileContents.mockResolvedValue({});

      await uploadScreenshotToGitHub("org/screenshots", "token", pngDataUrl);

      expect(mockGetRef).toHaveBeenCalledWith(expect.objectContaining({ ref: "heads/main" }));
      expect(mockCreateRef).toHaveBeenCalledWith(
        expect.objectContaining({ ref: "refs/heads/screenshots", sha: "abc123" }),
      );
    });

    it("propagates a non-404 error from checking the branch", async () => {
      mockGetBranch.mockRejectedValue({ status: 500 });

      await expect(
        uploadScreenshotToGitHub("org/screenshots", "token", pngDataUrl),
      ).rejects.toEqual({ status: 500 });
      expect(mockCreateRef).not.toHaveBeenCalled();
    });

    it("throws on a non-data URL", async () => {
      await expect(
        uploadScreenshotToGitHub("org/screenshots", "token", "not-a-data-url"),
      ).rejects.toThrow("not a valid base64 data URL");
    });
  });
});
