import { createHmac } from "node:crypto";

/** Build the signed identity headers accepted by Dynamic Agents. */
export function buildSignedUserContextHeaders(
  encodedUserContext: string,
): Record<string, string> {
  const secret = process.env.DA_USER_CONTEXT_HMAC_SECRET?.trim();
  if (!secret) {
    throw new Error("DA_USER_CONTEXT_HMAC_SECRET is not configured");
  }
  const signature = createHmac("sha256", secret)
    .update(encodedUserContext)
    .digest("hex");
  return {
    "X-User-Context": encodedUserContext,
    "X-User-Context-Signature": `v1=${signature}`,
  };
}
