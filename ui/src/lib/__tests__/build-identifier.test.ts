import {
  formatBuildIdentifier,
  formatCommitSha,
  formatComponentVersion,
  formatSemanticVersion,
} from "@/lib/build-identifier";

describe("build identifier formatting", () => {
  it.each([
    ["0.5.67", "v0.5.67"],
    ["v0.5.67", "v0.5.67"],
    ["0.5.69-dev.3", "v0.5.69-dev.3"],
    ["1.2.3+build.4", "v1.2.3+build.4"],
  ])("formats semantic version %s", (version, expected) => {
    expect(formatSemanticVersion(version)).toBe(expected);
  });

  it.each(["preview", "dev", "release-candidate", "1.2"]) (
    "does not attach v to non-semantic version %s",
    (version) => {
      expect(formatSemanticVersion(version)).toBeNull();
    },
  );

  it("uses the short commit SHA when the supplied version is not semantic", () => {
    expect(
      formatBuildIdentifier({
        version: "preview",
        packageVersion: "0.2.0",
        gitCommit: "6c5c6617a1234567890",
      }),
    ).toBe("6c5c661");
  });

  it("uses a semantic package version only when no deployed version is supplied", () => {
    expect(formatBuildIdentifier({ packageVersion: "0.2.0", gitCommit: "6c5c6617a" })).toBe(
      "v0.2.0",
    );
  });

  it("rejects values that are not commit SHAs", () => {
    expect(formatCommitSha("preview")).toBeNull();
    expect(formatCommitSha("abc123")).toBeNull();
  });

  it("preserves a non-semantic component version without inventing a v prefix", () => {
    expect(formatComponentVersion("preview")).toBe("preview");
  });
});
