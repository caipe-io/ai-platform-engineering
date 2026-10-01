/**
 * @jest-environment node
 */

import {
  _resetIngestorServiceAccountsCacheForTests,
  allowedSourceTypesForIngestorServiceAccount,
  isRecognizedIngestorServiceAccount,
} from "../ingestor-service-accounts";

const ENV_KEY = "RAG_INGESTOR_SERVICE_ACCOUNTS";

describe("ingestor-service-accounts", () => {
  const originalEnv = process.env[ENV_KEY];

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = originalEnv;
    }
    _resetIngestorServiceAccountsCacheForTests();
  });

  it("returns null when the env var is unset", () => {
    delete process.env[ENV_KEY];
    _resetIngestorServiceAccountsCacheForTests();
    expect(
      allowedSourceTypesForIngestorServiceAccount({
        isServiceAccount: true,
        sub: "service-account-slack-ingestor",
      }),
    ).toBeNull();
  });

  it("recognizes a service account keyed by raw sub and scoped to its source types", () => {
    process.env[ENV_KEY] = JSON.stringify({
      "service-account-slack-ingestor": ["slack_channel"],
    });
    _resetIngestorServiceAccountsCacheForTests();

    const session = { isServiceAccount: true, sub: "service-account-slack-ingestor" };
    expect(isRecognizedIngestorServiceAccount(session, "slack_channel")).toBe(true);
    expect(isRecognizedIngestorServiceAccount(session, "confluence_space")).toBe(false);
  });

  it("does not recognize a non-service-account session even with a matching sub", () => {
    process.env[ENV_KEY] = JSON.stringify({
      "service-account-slack-ingestor": ["slack_channel"],
    });
    _resetIngestorServiceAccountsCacheForTests();

    const session = { isServiceAccount: false, sub: "service-account-slack-ingestor" };
    expect(isRecognizedIngestorServiceAccount(session, "slack_channel")).toBe(false);
  });

  it("does not recognize an unlisted service account sub", () => {
    process.env[ENV_KEY] = JSON.stringify({
      "service-account-slack-ingestor": ["slack_channel"],
    });
    _resetIngestorServiceAccountsCacheForTests();

    const session = { isServiceAccount: true, sub: "service-account-unknown" };
    expect(isRecognizedIngestorServiceAccount(session, "slack_channel")).toBe(false);
  });

  it("supports multiple source types per service account", () => {
    process.env[ENV_KEY] = JSON.stringify({
      "service-account-multi-ingestor": ["slack_channel", "web_url"],
    });
    _resetIngestorServiceAccountsCacheForTests();

    const session = { isServiceAccount: true, sub: "service-account-multi-ingestor" };
    expect(isRecognizedIngestorServiceAccount(session, "slack_channel")).toBe(true);
    expect(isRecognizedIngestorServiceAccount(session, "web_url")).toBe(true);
    expect(isRecognizedIngestorServiceAccount(session, "jira_project")).toBe(false);
  });

  it("ignores malformed JSON and treats it as unrecognized", () => {
    process.env[ENV_KEY] = "{not-valid-json";
    _resetIngestorServiceAccountsCacheForTests();

    const session = { isServiceAccount: true, sub: "service-account-slack-ingestor" };
    expect(isRecognizedIngestorServiceAccount(session, "slack_channel")).toBe(false);
  });
});
