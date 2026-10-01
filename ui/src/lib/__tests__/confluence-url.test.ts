import { parseConfluenceLocator } from "../confluence-url";

describe("parseConfluenceLocator", () => {
  it("parses a page URL", () => {
    expect(
      parseConfluenceLocator(
        "https://example.atlassian.net/wiki/spaces/ENG/pages/123/Overview",
      ),
    ).toEqual({
      pageUrl: "https://example.atlassian.net/wiki/spaces/ENG/pages/123/Overview",
      baseUrl: "https://example.atlassian.net/wiki",
      spaceKey: "ENG",
      kind: "page",
      contentId: "123",
    });
  });

  it("parses a bare page URL with no trailing title segment", () => {
    expect(
      parseConfluenceLocator("https://example.atlassian.net/wiki/spaces/ENG/pages/123"),
    ).toMatchObject({ kind: "page", spaceKey: "ENG", contentId: "123" });
  });

  it("parses a folder URL", () => {
    expect(
      parseConfluenceLocator("https://example.atlassian.net/wiki/spaces/ENG/folder/456"),
    ).toEqual({
      pageUrl: "https://example.atlassian.net/wiki/spaces/ENG/folder/456",
      baseUrl: "https://example.atlassian.net/wiki",
      spaceKey: "ENG",
      kind: "folder",
      contentId: "456",
    });
  });

  it("parses a bare space root URL", () => {
    expect(
      parseConfluenceLocator("https://example.atlassian.net/wiki/spaces/ENG"),
    ).toEqual({
      pageUrl: "https://example.atlassian.net/wiki/spaces/ENG",
      baseUrl: "https://example.atlassian.net/wiki",
      spaceKey: "ENG",
      kind: "space",
    });
  });

  it("parses a space overview URL", () => {
    expect(
      parseConfluenceLocator("https://example.atlassian.net/wiki/spaces/ENG/overview"),
    ).toMatchObject({ kind: "space", spaceKey: "ENG" });
  });

  it("treats a space overview URL with a homepageId as a page", () => {
    // Confluence's own UI links to exactly this shape when viewing a space's
    // home page - it has no /pages/{id} segment, but homepageId genuinely
    // identifies one page. Regression case: without this, pasting a space's
    // home page URL silently created a whole-space source instead of a
    // page-scoped one.
    expect(
      parseConfluenceLocator(
        "https://example.atlassian.net/wiki/spaces/ENG/overview?homepageId=131942220914",
      ),
    ).toMatchObject({ kind: "page", spaceKey: "ENG", contentId: "131942220914" });
  });

  it("treats a bare space root URL with a homepageId as a page", () => {
    expect(
      parseConfluenceLocator("https://example.atlassian.net/wiki/spaces/ENG?homepageId=123"),
    ).toMatchObject({ kind: "page", contentId: "123" });
  });

  it("ignores a non-numeric homepageId", () => {
    const locator = parseConfluenceLocator(
      "https://example.atlassian.net/wiki/spaces/ENG/overview?homepageId=not-a-number",
    );
    expect(locator?.kind).toBe("space");
    expect(locator?.contentId).toBeUndefined();
  });

  it("decodes a URL-encoded space key", () => {
    expect(
      parseConfluenceLocator("https://example.atlassian.net/wiki/spaces/MY%20SPACE"),
    ).toMatchObject({ kind: "space", spaceKey: "MY SPACE" });
  });

  it("returns null for a space page-listing URL with no page id", () => {
    expect(
      parseConfluenceLocator("https://example.atlassian.net/wiki/spaces/ENG/pages"),
    ).toBeNull();
  });

  it("returns null for a non-Confluence URL", () => {
    expect(parseConfluenceLocator("https://example.com/docs")).toBeNull();
  });

  it("returns null for an empty or unparsable value", () => {
    expect(parseConfluenceLocator("")).toBeNull();
    expect(parseConfluenceLocator("not a url")).toBeNull();
  });

  it("returns null for a non-http(s) protocol", () => {
    expect(
      parseConfluenceLocator("ftp://example.atlassian.net/wiki/spaces/ENG"),
    ).toBeNull();
  });

  it("prefers a page match over a trailing folder-looking segment", () => {
    expect(
      parseConfluenceLocator(
        "https://example.atlassian.net/wiki/spaces/ENG/pages/123/folder/456",
      ),
    ).toMatchObject({ kind: "page", contentId: "123" });
  });

  it("returns null for a folder listing with no id", () => {
    expect(
      parseConfluenceLocator("https://example.atlassian.net/wiki/spaces/ENG/folder"),
    ).toBeNull();
  });

  it("ignores a trailing query string", () => {
    expect(
      parseConfluenceLocator("https://example.atlassian.net/wiki/spaces/ENG?foo=bar"),
    ).toMatchObject({ kind: "space", spaceKey: "ENG" });
    expect(
      parseConfluenceLocator(
        "https://example.atlassian.net/wiki/spaces/ENG/pages/123/Title?foo=bar",
      ),
    ).toMatchObject({ kind: "page", contentId: "123" });
  });
});
