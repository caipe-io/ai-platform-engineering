import { ApiError } from "@/lib/api-middleware";
import { findRealmUserIdByAttribute, mergeUserAttributes } from "@/lib/rbac/keycloak-admin";

const ALREADY_LINKED_ERROR = new ApiError(
  "This Webex account is already linked to a different enterprise user.",
  409,
  "WEBEX_ID_ALREADY_LINKED"
);

export async function assertWebexIdNotLinkedToOtherUser(
  webexUserId: string,
  keycloakSub: string
): Promise<void> {
  const existingOwner = await findRealmUserIdByAttribute("webex_user_id", webexUserId);
  if (existingOwner && existingOwner !== keycloakSub) {
    throw ALREADY_LINKED_ERROR;
  }
}

// Keycloak has no atomic compare-and-swap on custom attributes, so the
// check above and the write below can race: two grants for the same Webex
// account can both pass the check before either writes. Re-verify
// ownership after writing and roll back this write if a concurrent grant
// won the race, rather than leaving one Webex identity linked to two
// platform users.
export async function claimWebexIdentity(
  webexUserId: string,
  keycloakSub: string,
  attributes: { webex_user_email?: string[]; webex_user_id: string[] }
): Promise<void> {
  await assertWebexIdNotLinkedToOtherUser(webexUserId, keycloakSub);
  await mergeUserAttributes(keycloakSub, attributes);

  const ownerAfterWrite = await findRealmUserIdByAttribute("webex_user_id", webexUserId);
  if (ownerAfterWrite && ownerAfterWrite !== keycloakSub) {
    await mergeUserAttributes(keycloakSub, { webex_user_id: undefined, webex_user_email: undefined });
    throw ALREADY_LINKED_ERROR;
  }
}
