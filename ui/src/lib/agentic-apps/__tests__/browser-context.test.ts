/** @jest-environment node */
import { BROWSER_CONTEXT_HEADER, browserRequestContext, verifyAgenticAppBrowserContext } from "../browser-context";
import { mintAgenticAppToken } from "../tokens";

beforeEach(() => { process.env.AGENTIC_APP_TOKEN_SECRET = "example-test-secret-".repeat(3); });
afterEach(() => { delete process.env.AGENTIC_APP_TOKEN_SECRET; });

async function signedRequest(path = "/api/research") {
  const body = JSON.stringify({ question: "Example" });
  const proof = await mintAgenticAppToken({ appId: "example-app", subject: "primary-user", scopes: [],
    decisionId: "example-decision", correlationId: "example-request", ttlSeconds: 300,
    browserContext: browserRequestContext("POST", path, new TextEncoder().encode(body).buffer, "example-token") });
  return new Request(`https://app.example.test${path}`, { method: "POST", body,
    headers: { authorization: "Bearer example-token", [BROWSER_CONTEXT_HEADER]: proof.token } });
}

it("verifies app, subject, request and bounded lifetime without credentials in the proof", async () => {
  const token = await verifyAgenticAppBrowserContext(await signedRequest(), "example-app", "primary-user");
  expect(token.sub).toBe("primary-user");
  expect(token.exp - Number(token.iat)).toBe(60);
  expect(JSON.stringify(token)).not.toContain("example-token");
});

it.each(["body", "path", "query", "method", "token", "app", "subject", "missing"])("rejects substituted %s", async (change) => {
  const original = await signedRequest();
  const headers = new Headers(original.headers);
  if (change === "token") headers.set("authorization", "Bearer other-token");
  if (change === "missing") headers.delete(BROWSER_CONTEXT_HEADER);
  const request = new Request(`https://app.example.test${change === "path" ? "/api/other" : "/api/research"}${change === "query" ? "?scope=other" : ""}`, {
    method: change === "method" ? "PUT" : "POST", headers,
    body: change === "body" ? "{}" : await original.text(),
  });
  await expect(verifyAgenticAppBrowserContext(request, change === "app" ? "other-app" : "example-app",
    change === "subject" ? "other-user" : "primary-user")).rejects.toThrow();
});

it("binds a template-approved proof to its concrete project resource", async () => {
  const original = await signedRequest("/api/projects/first/research");
  await expect(verifyAgenticAppBrowserContext(original, "example-app", "primary-user")).resolves.toMatchObject({ sub: "primary-user" });
  const another = new Request("https://app.example.test/api/projects/second/research", {
    method: "POST", headers: original.headers, body: await original.text(),
  });
  await expect(verifyAgenticAppBrowserContext(another, "example-app", "primary-user")).rejects.toThrow();
});
