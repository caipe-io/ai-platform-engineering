import { DEFAULT_PLATFORM_FEEDBACK_FEATURES, parseFeedbackFeatures, platformFeedbackFeatures } from "../feedback-features";
it("provides platform areas and accepts a configured list", () => {
  expect(platformFeedbackFeatures(undefined)).toEqual(DEFAULT_PLATFORM_FEEDBACK_FEATURES);
  expect(platformFeedbackFeatures('[" Chat ","Chat","Custom area"]')).toEqual(["Chat", "Custom area"]);
});
it.each([[], [""], [5], ["a".repeat(41)], Array(33).fill("Feature"), null])("rejects invalid feature lists %j", value => {
  expect(() => parseFeedbackFeatures(value)).toThrow();
});
it("rejects malformed JSON", () => { expect(() => platformFeedbackFeatures("invalid")).toThrow("FEEDBACK_FEATURES"); });
