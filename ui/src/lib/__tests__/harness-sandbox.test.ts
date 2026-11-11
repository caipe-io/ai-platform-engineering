import { readHarnessSandbox, sandboxPortalUrl } from "../harness-sandbox";

it.each(["javascript:alert(1)", "data:text/plain,test", "//example.test", "https://user:secret@example.test", "https://example.test/?token=secret", "https://example.test/#secret", "http://example.test"])("rejects unsafe or credential-bearing management links: %s", value => {
  expect(sandboxPortalUrl(value)).toBeUndefined();
});

it("accepts an ordinary management path and local development portal", () => {
  expect(sandboxPortalUrl("https://sandbox.example.test/environments/1")).toBe("https://sandbox.example.test/environments/1");
  expect(sandboxPortalUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000/");
});

it("does not turn missing or malformed session metadata into a management capability", () => {
  expect(readHarnessSandbox(null)).toBeUndefined();
  expect(readHarnessSandbox({ portal_url: "https://sandbox.example.test", status: "ready" })).toBeUndefined();
  const item = { instance_id: "sandbox-1", display_name: "Primary", portal_url: "https://sandbox.example.test", policy_revision: "v1", policy_summary: "Private", status: "configured" };
  expect(readHarnessSandbox(item)?.portal_url).toBe("https://sandbox.example.test/");
  expect(readHarnessSandbox({ ...item, portal_url: "javascript:alert(1)" })).toBeUndefined();
});
