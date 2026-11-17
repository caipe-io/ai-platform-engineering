import { DEFAULT_PLATFORM_FEEDBACK_FEATURES, SERVICE_DESK_AREAS, SERVICE_DESK_DETAILS, SERVICE_DESK_SEVERITIES, SERVICE_DESK_TYPES, parseFeedbackFeatures, platformFeedbackFeatures } from "../feedback-features";
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
