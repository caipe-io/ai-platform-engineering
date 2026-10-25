// assisted-by claude code claude-sonnet-4-6

import type { ReasonCode } from "./contract";

export interface ReasonMeta {
  retriable: boolean;
  httpStatusHint: number;
  userActionHint: string;
}

const REASON_META: Record<ReasonCode, ReasonMeta> = {
  OK:               { retriable: false, httpStatusHint: 200, userActionHint: "" },
  NO_CAPABILITY:    { retriable: false, httpStatusHint: 200, userActionHint: "contact_admin" },
  NOT_AUTHENTICATED:{ retriable: false, httpStatusHint: 401, userActionHint: "sign_in" },
  AUTHZ_UNAVAILABLE:{ retriable: true,  httpStatusHint: 503, userActionHint: "retry" },
  INVALID_REQUEST:  { retriable: false, httpStatusHint: 400, userActionHint: "fix_request" },
  PRIVATE_RESOURCE_CONTEXT_DENIED: {
    retriable: false,
    httpStatusHint: 403,
    userActionHint: "open_direct_message",
  },
};

export function getReasonMeta(code: ReasonCode): ReasonMeta {
  return REASON_META[code];
}
