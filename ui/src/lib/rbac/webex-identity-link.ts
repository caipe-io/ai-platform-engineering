import { ApiError } from "@/lib/api-error";
import { withWebexIdentityWriteLock } from "@/lib/rbac/webex-identity-write-lock";
import { findRealmUserIdsByAttribute, getRealmUserById, mergeUserAttributes } from "@/lib/rbac/keycloak-admin";
import { getRbacCollection } from "@/lib/rbac/mongo-collections";
import { setWebexIdentityForUserRoutes } from "@/lib/rbac/webex-direct-user-route-store";

const ALREADY_LINKED_ERROR = new ApiError(
  "This Webex account or enterprise user already has a different link. Unlink it first.",
  409,
  "WEBEX_ID_ALREADY_LINKED"
);

function identityKey(kind: string, value: string): string {
  return `${kind}:${process.env.KEYCLOAK_REALM || "caipe"}:${value}`;
}

async function readIdentityState<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ApiError && error.code === "WEBEX_ID_ALREADY_LINKED") throw error;
    throw new ApiError("Identity lookup is temporarily unavailable. Please retry.", 503, "WEBEX_LINK_LOOKUP_UNAVAILABLE");
  }
}

export async function assertWebexIdNotLinkedToOtherUser(
  webexUserId: string,
  keycloakSub: string
): Promise<void> {
  const owners = await findRealmUserIdsByAttribute("webex_user_id", webexUserId);
  if (owners.some((owner) => owner !== keycloakSub) || owners.length > 1) {
    throw ALREADY_LINKED_ERROR;
  }
}

export async function claimWebexIdentity(
  webexUserId: string,
  keycloakSub: string,
  attributes: { webex_user_email?: string[]; webex_user_id: string[] }
): Promise<void> {
  await withWebexIdentityWriteLock(async () => {
    const collection = await getRbacCollection("webexIdentityBindings");
    const [binding, account, user] = await readIdentityState(() => Promise.all([
      collection.findOne({ _id: identityKey("binding", webexUserId) } as never),
      collection.findOne({ _id: identityKey("account", keycloakSub) } as never),
      getRealmUserById(keycloakSub),
      assertWebexIdNotLinkedToOtherUser(webexUserId, keycloakSub),
    ]));
    if ((binding && binding.user_id !== keycloakSub) || (account && account.person_id !== webexUserId)) {
      throw ALREADY_LINKED_ERROR;
    }
    const attrs = (user.attributes || {}) as Record<string, string[]>;
    const current = attrs.webex_user_id || [];
    if (user.enabled === false || (current.length && (current.length !== 1 || current[0] !== webexUserId))) {
      throw ALREADY_LINKED_ERROR;
    }
    // Persist both claims before Keycloak; directory search can lag behind writes.
    await collection.updateOne(
      { _id: identityKey("binding", webexUserId) } as never,
      { $set: { user_id: keycloakSub } }, { upsert: true },
    );
    await collection.updateOne(
      { _id: identityKey("account", keycloakSub) } as never,
      { $set: { person_id: webexUserId } }, { upsert: true },
    );
    await mergeUserAttributes(keycloakSub, {
      ...attributes,
      webex_link_method: ["sso"],
      webex_linked_at: [new Date().toISOString()],
      webex_auto_link_disabled: undefined,
    });
    const persisted = await getRealmUserById(keycloakSub);
    const persistedId = (persisted.attributes as Record<string, unknown> | undefined)?.webex_user_id;
    if (persisted.enabled === false || !Array.isArray(persistedId) || persistedId.length !== 1 || persistedId[0] !== webexUserId) {
      throw new Error("Webex identity write could not be verified");
    }
    await setWebexIdentityForUserRoutes(keycloakSub, webexUserId);
    await collection.deleteOne({ _id: identityKey("blocked", webexUserId) } as never);
  });
}

/** Unlink suppresses automatic matching until a successful explicit OAuth link. */
export async function unlinkWebexIdentity(keycloakSub: string): Promise<void> {
  await withWebexIdentityWriteLock(async () => {
    const user = await readIdentityState(() => getRealmUserById(keycloakSub));
    const attrs = (user.attributes || {}) as Record<string, string[]>;
    const collection = await getRbacCollection("webexIdentityBindings");
    const account = await readIdentityState(() => collection.findOne({ _id: identityKey("account", keycloakSub) } as never));
    const people = new Set(attrs.webex_user_id || []);
    if (typeof account?.person_id === "string") people.add(account.person_id);
    for (const personId of people) {
      await collection.updateOne(
        { _id: identityKey("blocked", personId) } as never,
        { $set: { blocked_at: new Date().toISOString() } },
        { upsert: true },
      );
    }
    await mergeUserAttributes(keycloakSub, {
      webex_user_id: undefined,
      webex_user_email: undefined,
      webex_link_method: undefined,
      webex_linked_at: undefined,
      webex_auto_link_disabled: ["true"],
    });
    await setWebexIdentityForUserRoutes(keycloakSub, null);
    for (const personId of people) {
      await collection.deleteOne({ _id: identityKey("binding", personId), user_id: keycloakSub } as never);
    }
    await collection.deleteOne({ _id: identityKey("account", keycloakSub) } as never);
  });
}
