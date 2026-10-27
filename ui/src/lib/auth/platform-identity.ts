/** Identity profile for new service/delegation APIs; not a permission grant. */
export const PLATFORM_ACCESS_AUDIENCE = "caipe-access";
export const PLATFORM_PRINCIPAL_TYPE_CLAIM = "caipe_principal_type";

export interface PlatformPrincipal {
  type: "user" | "service_account";
  id: string;
}

export interface PlatformIdentity {
  issuer: string;
  subject: PlatformPrincipal;
  /** Verified authorized-party client, distinct from the subject. */
  clientId: string;
  expiresAt: number;
}
