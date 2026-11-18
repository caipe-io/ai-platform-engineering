import { DEFAULT_PLATFORM_FEEDBACK_FEATURES, SERVICE_DESK_AREAS, SERVICE_DESK_DETAILS, SERVICE_DESK_SEVERITIES, SERVICE_DESK_TYPES, boundedContextUrl, parseFeedbackFeatures, platformFeedbackFeatures } from "../feedback-features";
it("provides platform areas and accepts a configured list", () => {
  expect(platformFeedbackFeatures(undefined)).toEqual(DEFAULT_PLATFORM_FEEDBACK_FEATURES);
  expect(platformFeedbackFeatures('[" Chat ","Chat","Custom area"]')).toEqual(["Chat", "Custom area"]);
});
it.each([[], [""], [5], ["a".repeat(41)], Array(33).fill("Feature"), null])("rejects invalid feature lists %j", value => {
  expect(() => parseFeedbackFeatures(value)).toThrow();
});
it("rejects malformed JSON", () => { expect(() => platformFeedbackFeatures("invalid")).toThrow("FEEDBACK_FEATURES"); });

describe("Request help options", () => {
  it("match the fixed list of areas, severities and types", () => {
    expect([...SERVICE_DESK_AREAS]).toEqual([
      "Compute", "ArgoCD", "Vault", "GitHub", "Directory groups", "Logging", "Kubernetes", "Platform", "SSO / IAM", "CI / GitHub Actions",
      "Infrastructure as code", "Artifacts / Registries", "Data Services", "AI / ML", "Networking / DNS / Certificates", "Sandboxes", "Applications", "Other",
    ]);
    expect([...SERVICE_DESK_SEVERITIES]).toEqual(["Urgent", "High", "Medium", "Low"]);
    expect([...SERVICE_DESK_TYPES]).toEqual(["Bug", "Enhancement", "Ticket"]);
  });
  it("only add detail questions for known areas and never repeat a label", () => {
    for (const [area, fields] of Object.entries(SERVICE_DESK_DETAILS)) {
      expect(SERVICE_DESK_AREAS).toContain(area);
      expect(new Set(fields.map(field => field.label)).size).toBe(fields.length);
    }
  });
});

describe("boundedContextUrl", () => {
  it("keeps a short URL unchanged", () => {
    expect(boundedContextUrl("https://example.com/a?b=1#c")).toBe("https://example.com/a?b=1#c");
  });
  it("drops the hash, then the query, to fit the limit", () => {
    expect(boundedContextUrl(`https://example.com/a?b=1#${"x".repeat(2000)}`)).toBe("https://example.com/a?b=1");
    expect(boundedContextUrl(`https://example.com/a?b=${"x".repeat(2000)}`)).toBe("https://example.com/a");
  });
  it("cuts an over-long path and always returns at most 2000 characters", () => {
    const result = boundedContextUrl(`https://example.com/${"p".repeat(2500)}`);
    expect(result.length).toBe(2000);
    expect(() => new URL(result)).not.toThrow();
  });
});
