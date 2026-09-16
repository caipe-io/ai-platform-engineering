import type { Document } from 'mongodb';

/** Prefix conversation predicates after a lookup, preserving logical operators. */
function conversationPredicate(filter: Document): Document {
  return Object.fromEntries(Object.entries(filter).map(([key, value]) => [
    key.startsWith('$') ? key : `_conversation.${key}`,
    ['$and', '$or', '$nor'].includes(key)
      ? (value as Document[]).map(conversationPredicate)
      : value,
  ]));
}

export interface ChatActivityOptions {
  from: Date;
  to: Date;
  conversationFilter: Document;
  source?: string | null;
  /** Undefined means no user filter; an empty array must match nothing. */
  senders?: string[];
  botOwnerIds: string[];
}

/**
 * Recorded human chat activity, keyed by immutable prompt time and sender.
 * Require a retained, visible parent conversation. Unknown origins and API,
 * scheduler and autonomous traffic cannot establish human engagement.
 * Historical messages without a sender retain conversation-owner attribution.
 */
export function buildChatActivityPipeline(options: ChatActivityOptions): Document[] {
  const { from, to, conversationFilter, source, senders, botOwnerIds } = options;
  return [
    { $match: {
      role: 'user',
      created_at: { $gte: from, $lte: to },
      'metadata.source': { $in: source ? [source].filter((s) => ['web', 'slack', 'webex'].includes(s)) : ['web', 'slack', 'webex'] },
      'metadata.sender_is_bot': { $ne: true },
    } },
    { $project: { created_at: 1, conversation_id: 1, sender_email: 1 } },
    { $lookup: { from: 'conversations', localField: 'conversation_id', foreignField: '_id', as: '_conversation' } },
    { $unwind: '$_conversation' },
    { $match: { $and: [
      conversationPredicate(conversationFilter),
      { '_conversation.source': { $nin: ['scheduler', 'autonomous', 'api'] } },
      { '_conversation.client_type': { $nin: ['scheduler', 'autonomous', 'api'] } },
      { '_conversation.metadata.owner_is_bot': { $ne: true } },
    ] } },
    { $set: { _actor: { $cond: [
      { $and: [{ $eq: [{ $type: '$sender_email' }, 'string'] }, { $ne: ['$sender_email', ''] }] },
      '$sender_email',
      '$_conversation.owner_id',
    ] } } },
    { $match: { $and: [
      { _actor: { $type: 'string', $nin: ['', 'unknown', 'USLACKBOT', ...botOwnerIds] } },
      { _actor: { $not: /^B[A-Z0-9]{6,}$/ } },
      { _actor: { $not: /^service-account-/ } },
      ...(senders ? [{ _actor: { $in: senders } }] : []),
    ] } },
  ];
}
