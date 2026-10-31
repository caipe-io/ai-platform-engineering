import { createHash } from "node:crypto";

import type { AuthResult } from "@/lib/da-proxy";
import { getCollection } from "@/lib/mongodb";

/** Convert authenticated chat uploads to conversation-scoped opaque references. */
export async function stageHarnessAttachments(
  files: unknown, auth: AuthResult, agentId: string, conversationId: string,
): Promise<Array<{ id: string }>> {
  if (files === undefined || Array.isArray(files) && files.length === 0) return [];
  if (!auth.subject || !Array.isArray(files) || files.length > 20) throw new TypeError("Invalid attachments");
  const blobs = await getCollection<{ _id: string; owner_subject: string; agent_id: string; conversation_id: string; file: unknown; expires_at: Date }>("harness_attachment_blobs");
  let total = 0;
  const references: Array<{ id: string }> = [];
  for (const file of files) {
    if (!file || typeof file !== "object" || typeof file.data !== "string" || !file.data ||
        typeof file.mime_type !== "string" || file.mime_type.length > 128 ||
        file.name !== undefined && (typeof file.name !== "string" || file.name.length > 512) ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data) || file.data.length % 4 !== 0) {
      throw new TypeError("Attachments require inline base64 data and a MIME type");
    }
    const size = Buffer.byteLength(file.data, "base64");
    total += size;
    if (size > 5 * 1024 * 1024 || total > 20 * 1024 * 1024) throw new TypeError("Attachment size limit exceeded");
    const normalized = { data: file.data, mime_type: file.mime_type, ...(file.name && { name: file.name }) };
    // Identical retries retain the same references and therefore the same
    // admission fingerprint. A reference is useful only to this caller/thread.
    const id = createHash("sha256").update(JSON.stringify([auth.subject, agentId, conversationId, normalized])).digest("hex");
    await blobs.updateOne({ _id: id }, {
      $setOnInsert: { owner_subject: auth.subject, agent_id: agentId, conversation_id: conversationId, file: normalized },
      $set: { expires_at: new Date(Date.now() + 86400_000) },
    }, { upsert: true });
    references.push({ id });
  }
  return references;
}
