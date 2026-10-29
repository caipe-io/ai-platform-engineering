import { createHash } from "node:crypto";

import { verifyAgenticAppToken, type VerifiedAgenticAppToken } from "./tokens";

export const BROWSER_CONTEXT_HEADER = "x-caipe-browser-context";

export interface AgenticAppBrowserContext {
  kind: "browser-session";
  method: string;
  path: string;
  bodyHash: string;
  tokenHash: string;
}

export function browserRequestContext(
  method: string, path: string, body: ArrayBuffer | undefined, bearerToken: string,
): AgenticAppBrowserContext {
  return { kind: "browser-session", method: method.toUpperCase(), path,
    bodyHash: createHash("sha256").update(Buffer.from(body ?? new ArrayBuffer(0))).digest("hex"),
    tokenHash: createHash("sha256").update(bearerToken).digest("hex") };
}

/** Verify on the app server before using a browser-only action; no cookie credentials are forwarded. */
export async function verifyAgenticAppBrowserContext(
  request: Request, appId: string, authenticatedSubject: string,
): Promise<VerifiedAgenticAppToken> {
  const assertion = request.headers.get(BROWSER_CONTEXT_HEADER);
  const bearer = request.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1];
  if (!assertion || assertion.length > 16384 || assertion.split(".").length !== 3 || !bearer) {
    throw new Error("Browser context is required");
  }
  const token = await verifyAgenticAppToken(assertion, appId);
  const now = Math.floor(Date.now() / 1000);
  if (!authenticatedSubject || token.sub !== authenticatedSubject || token.purpose !== "browser-request" || typeof token.iat !== "number" ||
      token.iat > now + 5 || token.exp - token.iat > 60) throw new Error("Invalid browser context lifetime");
  const target = new URL(request.url);
  const expected = browserRequestContext(request.method, target.pathname + target.search,
    ["GET", "HEAD"].includes(request.method) ? undefined : await request.clone().arrayBuffer(), bearer);
  const context = token.browser_context as Partial<AgenticAppBrowserContext> | undefined;
  if (!context || Object.entries(expected).some(([key, value]) => context[key as keyof AgenticAppBrowserContext] !== value)) {
    throw new Error("Browser context does not match this request");
  }
  return token;
}
