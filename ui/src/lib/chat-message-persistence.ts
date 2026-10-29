import { createHash } from "node:crypto";
import { ObjectId, type Collection, type Document } from "mongodb";

import type { Message } from "@/types/mongodb";

/** One assistant row per app turn, including browser saves racing a status recovery. */
export async function upsertChatMessage(
  messages: Collection<Message>,
  input: {
    conversationId: string;
    messageId?: string;
    role: Message["role"];
    turnId: string;
    appTurn?: boolean;
    trustedCompletion?: boolean;
    fields: Document;
    insert: Document;
  },
) {
  let filter: Document = { message_id: input.messageId, conversation_id: input.conversationId };
  if (input.appTurn && input.role === "assistant") {
    const previous = await messages.findOne({ conversation_id: input.conversationId,
      role: "assistant", "metadata.turn_id": input.turnId }, { projection: { _id: 1 } });
    const id = previous?._id ?? new ObjectId(createHash("sha256")
      .update(JSON.stringify(["app-assistant-turn", input.conversationId, input.turnId])).digest("hex").slice(0, 24));
    filter = { _id: id, conversation_id: input.conversationId };
  }
  const fields = { ...input.fields, ...(input.fields.metadata ? { metadata: { ...input.fields.metadata } } : {}) };
  if (!input.trustedCompletion && fields.metadata) Reflect.deleteProperty(fields.metadata, "app_completion");
  const update = [{ $set: {
    ...Object.fromEntries(Object.entries(input.insert).map(([key, value]) =>
      [key, { $cond: [{ $eq: [{ $type: "$role" }, "missing"] }, { $literal: value }, `$${key}`] }])),
    // The marker is server-owned. Every subsequent write preserves the accepted
    // result atomically, including a delayed interrupted browser placeholder.
    ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { $cond: [
      { $ne: [{ $type: "$metadata.app_completion" }, "missing"] },
      key === "stream_events" ? { $ifNull: [`$${key}`, { $literal: value }] } : `$${key}`,
      key === "metadata" && value.app_completion ? { $mergeObjects: ["$metadata", { $literal: value }] } : { $literal: value },
    ] }])),
  } }];
  let result;
  try {
    result = await messages.updateOne(filter, update, { upsert: true });
  } catch (error) {
    if (!input.appTurn || (error as { code?: number }).code !== 11000) throw error;
    // Concurrent inserts share the deterministic Mongo _id; retry the same
    // guarded update against the winner instead of creating another message.
    result = await messages.updateOne(filter, update);
  }
  return { result, message: await messages.findOne(filter) };
}
