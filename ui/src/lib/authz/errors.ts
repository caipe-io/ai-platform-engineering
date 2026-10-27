// Shared failures carry HTTP metadata without loading request/response handling
// into the authorization domain or persistence layer.
export type MetaCode = "NOT_AUTHENTICATED" | "FORBIDDEN" | "INVALID_REQUEST" | "AUTHZ_UNAVAILABLE";

export class HttpAuthzError extends Error {
  constructor(
    readonly status: number,
    readonly code: MetaCode,
    message: string,
  ) {
    super(message);
    this.name = "HttpAuthzError";
  }
}
