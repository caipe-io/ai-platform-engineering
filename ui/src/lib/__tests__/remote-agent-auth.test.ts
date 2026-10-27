import { normalizeRemoteAgentCredentialSource } from "../remote-agent-auth";

describe("remote A2A authentication configuration", () => {
  it("preserves caller JWT forwarding for existing registry entries", () => {
    expect(normalizeRemoteAgentCredentialSource(undefined)).toEqual({
      kind: "caller_token", target: "header", name: "Authorization",
    });
  });

  it.each([
    { kind: "caller_token", target: "header", name: "X-User-JWT" },
    { kind: "secret_ref", target: "header", name: "X-API-Key", secret_ref: "example-secret" },
    { kind: "provider_connection", target: "header", name: "Authorization", provider: "example" },
  ])("accepts $kind and stores only a header and credential reference", (source) => {
    expect(normalizeRemoteAgentCredentialSource({ ...source, value: "must-not-be-stored" })).toEqual(source);
  });

  it.each([
    { kind: "caller_token", name: "invalid\r\nheader" },
    { kind: "caller_token", name: "" },
    { kind: "caller_token", name: "Authorization", target: "env" },
    { kind: "secret_ref", name: "Authorization" },
    { kind: "provider_connection", name: "Authorization" },
    { kind: "unknown", name: "Authorization" },
  ])("rejects invalid authentication metadata %#", (source) => {
    expect(() => normalizeRemoteAgentCredentialSource(source)).toThrow();
  });
});
