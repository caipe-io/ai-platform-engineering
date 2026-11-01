import { createHash, randomUUID } from "crypto";
import { setTimeout as delay } from "timers/promises";

import type { AuthResult } from "@/lib/da-proxy";
import { getCollection } from "@/lib/mongodb";
import type { ConversationPresence } from "@/types/conversation-presence";

interface ViewerLease {
  _id: string;
  conversation_id: string;
  viewer_id: string;
  name: string;
  expires_at: Date;
}

const REFRESH_MS = 5_000;
const LEASE_MS = 30_000;
const REAUTHORIZE_MS = 15_000;

/** Presence belongs to the visible chat, independently of its agent/run lifecycle. */
export function conversationPresenceStream(
  conversationId: string,
  auth: AuthResult,
  signal: AbortSignal,
  canRead: () => Promise<boolean>,
): ReadableStream<Uint8Array> {
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) stop.abort();
  // Renew the authenticated request before the hosting platform's duration limit.
  const deadline = setTimeout(onAbort, 290_000);
  const connectionId = randomUUID();
  const viewerId = createHash("sha256").update(JSON.stringify([
    conversationId, auth.isServiceAccount ? "service_account" : "user", auth.subject,
  ])).digest("hex");
  const name = (auth.authenticatedUser?.user?.name?.trim() || auth.email || "Viewer").slice(0, 200);
  const encoder = new TextEncoder();
  let cancelled = false;

  return new ReadableStream({
    async start(controller) {
      let leases: Awaited<ReturnType<typeof getCollection<ViewerLease>>> | undefined;
      try {
        leases = await getCollection<ViewerLease>("conversation_viewers");
        let reauthorizeAt = Date.now() + REAUTHORIZE_MS;
        while (!stop.signal.aborted) {
          if (Date.now() >= reauthorizeAt) {
            if (!(await canRead())) {
              if (!stop.signal.aborted) controller.enqueue(encoder.encode("event: access-revoked\ndata: {}\n\n"));
              break;
            }
            reauthorizeAt = Date.now() + REAUTHORIZE_MS;
          }
          if (stop.signal.aborted) break;
          const now = new Date();
          await leases.updateOne({ _id: connectionId }, { $set: {
            conversation_id: conversationId, viewer_id: viewerId, name,
            expires_at: new Date(now.getTime() + LEASE_MS),
          } }, { upsert: true });
          const groups = await leases.aggregate<{ _id: string; name: string; sessions: number }>([
            { $match: { conversation_id: conversationId, expires_at: { $gt: now } } },
            { $group: { _id: "$viewer_id", name: { $max: "$name" }, sessions: { $sum: 1 } } },
            { $sort: { _id: 1 } },
          ]).toArray();
          const snapshot: ConversationPresence = {
            viewers: groups.map(({ _id, ...viewer }) => ({ id: _id, ...viewer })),
            sessionCount: groups.reduce((total, viewer) => total + viewer.sessions, 0),
          };
          if (stop.signal.aborted) break;
          controller.enqueue(encoder.encode(`event: presence\ndata: ${JSON.stringify(snapshot)}\n\n`));
          await delay(REFRESH_MS, undefined, { signal: stop.signal });
        }
      } catch (error) {
        if (!stop.signal.aborted) console.warn("[chat-presence] Subscription failed:", error);
      } finally {
        clearTimeout(deadline);
        signal.removeEventListener("abort", onAbort);
        try { await leases?.deleteOne({ _id: connectionId }); }
        catch (error) { console.warn("[chat-presence] Could not release viewer lease:", error); }
        if (!cancelled) controller.close();
      }
    },
    cancel() { cancelled = true; stop.abort(); },
  });
}
