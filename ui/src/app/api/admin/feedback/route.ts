// GET /api/admin/feedback - Get paginated feedback entries for admin dashboard
//
// Reads from the unified `feedback` collection (populated by web dual-write,
// Slack bot, and backfill scripts).

import {
getAuthFromBearerOrSession,
requireRbacPermission,
successResponse,
withErrorHandler,
} from '@/lib/api-middleware';
import { getConfig } from '@/lib/config';
import { getCollection,isMongoDBConfigured } from '@/lib/mongodb';
import { applyInsightsCacheHeaders, cachedInsights, feedbackRangeBounds, insightsFilterKey, INSIGHTS_QUERY_TIMEOUT_MS, type InsightsScope } from '@/lib/insights-cache';
import {
resolveAuthorizedAdminSimulationScope,
simulationSubjectCanManageAdminSurface,
} from '@/lib/rbac/admin-simulation-server';
import { resolveInsightsUserFilter } from '@/lib/rbac/insights-user-filter';
import { getOwnedAgentConversationIds, getOwnedAgents, getReadableSlackChannelNames, type OwnedAgent } from '@/lib/rbac/user-insights-scope';
import type { Conversation } from '@/types/mongodb';
import type { Document,ObjectId } from 'mongodb';
import { NextRequest,NextResponse } from 'next/server';

interface FeedbackDocument extends Document {
  _id?: ObjectId;
  channel_name?: string;
  comment?: string;
  conversation_id?: string;
  created_at?: Date;
  message_id?: string;
  rating?: string;
  slack_permalink?: string;
  source?: string;
  trace_id?: string;
  user_email?: string;
  user_id?: string;
  value?: string;
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  if (!getConfig('feedbackEnabled')) {
    return NextResponse.json(
      { success: false, error: 'Feedback feature is not enabled', code: 'FEEDBACK_DISABLED' },
      { status: 404 }
    );
  }

  if (!isMongoDBConfigured) {
    return NextResponse.json(
      {
        success: false,
        error: 'MongoDB not configured - admin features require MongoDB',
        code: 'MONGODB_NOT_CONFIGURED',
      },
      { status: 503 }
    );
  }

  const { session } = await getAuthFromBearerOrSession(request);
  const { searchParams } = request.nextUrl;
  const simulationScope = await resolveAuthorizedAdminSimulationScope(searchParams, session);
  const isFullAdmin = simulationScope
    ? await simulationSubjectCanManageAdminSurface(simulationScope, 'feedback')
    : await requireRbacPermission(session, 'admin_ui', 'view').then(
        () => true,
        () => false
      );

  let scopedChannelNames: string[] | null = null;
  let scopedOwnerEmail: string | null = null;
  let scopedOwnedAgentConvIds: string[] | null = null;
  let scopedOwnedAgents: OwnedAgent[] = [];
  if (!isFullAdmin) {
    const openfgaUser = simulationScope?.openfgaUser ?? (
      typeof session.sub === 'string' && session.sub.trim()
        ? `user:${session.sub.trim()}`
        : ''
    );
    const email = simulationScope?.ownerEmail ?? (
      typeof session.user?.email === 'string' ? session.user.email.trim() : ''
    );
    if (!openfgaUser) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' },
        { status: 401 }
      );
    }
    const [channelNames, ownedAgents] = await Promise.all([
      getReadableSlackChannelNames(openfgaUser),
      getOwnedAgents(openfgaUser),
    ]);
    scopedChannelNames = channelNames;
    scopedOwnerEmail = email || null;
    scopedOwnedAgents = ownedAgents;
  }

  const cacheScope: InsightsScope = {
    fullAdmin: isFullAdmin,
    subject: simulationScope?.openfgaUser ?? session.sub,
    ownerEmail: scopedOwnerEmail,
    channelNames: scopedChannelNames,
    ownedAgents: scopedOwnedAgents,
    simulation: simulationScope ? simulationScope.openfgaUser : null,
  };
  const rating = searchParams.get('rating'); // 'positive' | 'negative' | null (all)
  const source = searchParams.get('source'); // 'web' | 'slack' | null (all)
  const channel = searchParams.get('channel'); // comma-separated channel names | null (all)
  const userFilter = searchParams.get('user'); // comma-separated user emails | null (all)
  const teamFilter = searchParams.get('team'); // comma-separated team slugs | null (all)
  const { active: hasUserFilter, emails: userEmails } = await resolveInsightsUserFilter(
    userFilter,
    teamFilter,
  );
  const search = searchParams.get('search'); // comma-separated search terms OR'd as regex on comment/value
  const { from, to } = feedbackRangeBounds(searchParams);
  const requestedPage = Number.parseInt(searchParams.get('page') || '1', 10);
  const requestedLimit = Number.parseInt(searchParams.get('limit') || '50', 10);
  const page = Number.isFinite(requestedPage) ? Math.max(1, requestedPage) : 1;
  const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, requestedLimit)) : 50;
  const skip = (page - 1) * limit;

  const feedbackColl = await getCollection<FeedbackDocument>('feedback');

  const filter: Document = {};
  if (rating === 'positive' || rating === 'negative') {
    filter.rating = rating;
  }
  if (source === 'web') {
    filter.source = 'web';
  } else if (source === 'slack') {
    filter.source = 'slack';
    if (channel) {
      const channels = channel.split(',').map((c) => c.trim()).filter(Boolean);
      if (channels.length === 1) {
        filter.channel_name = channels[0];
      } else if (channels.length > 1) {
        filter.channel_name = { $in: channels };
      }
    }
  }
  if (hasUserFilter) {
    filter.user_email = userEmails.length === 1 ? userEmails[0] : { $in: userEmails };
  }
  if (search) {
    const terms = search.split(',').map((t) => t.trim()).filter(Boolean);
    if (terms.length > 0) {
      // Each term matches comment or value via regex, OR'd together
      filter.$or = terms.flatMap((term) => {
        const regex = { $regex: term, $options: 'i' };
        return [{ comment: regex }, { value: regex }];
      });
    }
  }
  if (from || to) {
    filter.created_at = {};
    if (from) filter.created_at.$gte = new Date(from);
    if (to) filter.created_at.$lte = new Date(to);
  }

  let filterPromise: Promise<Document> | undefined;
  const getScopedFilter = (): Promise<Document> => filterPromise ??= (async () => {
    if (isFullAdmin) return filter;
    scopedOwnedAgentConvIds = scopedOwnedAgents.length > 0
      ? (await getOwnedAgentConversationIds(scopedOwnedAgents)).ids
      : [];
    const scopeClauses: Document[] = [];
    if (scopedChannelNames?.length) scopeClauses.push({ source: 'slack', channel_name: scopedChannelNames.length === 1 ? scopedChannelNames[0] : { $in: scopedChannelNames } });
    if (scopedOwnerEmail) scopeClauses.push({ user_email: scopedOwnerEmail });
    if (scopedOwnedAgentConvIds.length) scopeClauses.push({ conversation_id: { $in: scopedOwnedAgentConvIds } });
    if (!scopeClauses.length) return { _id: { $in: [] } };
    const scoped: Document = { ...filter };
    if (scoped.$or) {
      const existingOr = scoped.$or;
      delete scoped.$or;
      scoped.$and = [{ $or: existingOr }, { $or: scopeClauses }];
    } else scoped.$or = scopeClauses;
    return scoped;
  })();

  const [pageResult, totalResult, optionsResult, summaryResult] = await Promise.all([
    cachedInsights(request, 'insights.feedback.page', cacheScope, insightsFilterKey(searchParams), async () => {
      const docs = await feedbackColl.find(await getScopedFilter(), { maxTimeMS: INSIGHTS_QUERY_TIMEOUT_MS })
        .sort({ created_at: -1 }).skip(skip).limit(limit).toArray();
      const convIds = [...new Set(docs.flatMap((doc) => doc.conversation_id ? [doc.conversation_id] : []))];
      let titles = new Map<string, string>();
      if (convIds.length) {
        const conversations = await getCollection<Conversation>('conversations');
        const convDocs = await conversations.find({ _id: { $in: convIds } }, {
          projection: { _id: 1, title: 1 }, maxTimeMS: INSIGHTS_QUERY_TIMEOUT_MS,
        }).toArray();
        titles = new Map(convDocs.map((conversation) => [conversation._id, conversation.title]));
      }
      return docs.map((doc) => feedbackEntry(doc, titles));
    }),
    cachedInsights(request, 'insights.feedback.count', cacheScope,
      insightsFilterKey(searchParams, ['page', 'limit']),
      async () => feedbackColl.countDocuments(await getScopedFilter(), { maxTimeMS: INSIGHTS_QUERY_TIMEOUT_MS })),
    cachedInsights(request, 'insights.feedback.options', cacheScope,
      isFullAdmin ? {} : insightsFilterKey(searchParams, ['page', 'limit']), async () => {
        const scopedFilter = isFullAdmin ? {} : await getScopedFilter();
        return Promise.all([
          feedbackColl.distinct('channel_name', { ...scopedFilter, source: 'slack', channel_name: { $ne: null } }, { maxTimeMS: INSIGHTS_QUERY_TIMEOUT_MS }),
          feedbackColl.distinct('user_email', { ...scopedFilter, user_email: { $ne: null } }, { maxTimeMS: INSIGHTS_QUERY_TIMEOUT_MS }),
        ]);
      }),
    cachedInsights(request, 'insights.feedback.summary', cacheScope,
      insightsFilterKey(searchParams, ['page', 'limit', 'rating']), async () => {
        const { rating: _rating, ...summaryFilter } = await getScopedFilter();
        void _rating;
        return feedbackColl.aggregate([
          { $match: summaryFilter },
          { $group: { _id: '$rating', count: { $sum: 1 } } },
        ], { maxTimeMS: INSIGHTS_QUERY_TIMEOUT_MS }).toArray();
      }),
  ]);
  const entries = pageResult.value;
  const totalCount = totalResult.value;
  const [channels, distinctUsers] = optionsResult.value;
  const summaryCounts = summaryResult.value;

  let positive = 0;
  let negative = 0;
  for (const row of summaryCounts as Array<{ _id: string; count: number }>) {
    if (row._id === 'positive') positive = row.count;
    else if (row._id === 'negative') negative = row.count;
  }
  const summaryTotal = positive + negative;
  const summary = {
    positive,
    negative,
    total: summaryTotal,
    positive_rate: summaryTotal > 0 ? Math.round((positive / summaryTotal) * 100) : 0,
  };

  const computedAt = Math.min(...[pageResult, totalResult, optionsResult, summaryResult].map((result) => result.computedAt));
  const states = [pageResult, totalResult, optionsResult, summaryResult].map((result) => result.state);
  const state = states.includes('stale') ? 'stale' : states.includes('miss') ? 'miss' : states.includes('shared') ? 'shared' : 'hit';
  return applyInsightsCacheHeaders(successResponse({
    entries,
    channels: (channels as string[]).sort(),
    users: (distinctUsers as string[]).sort(),
    summary,
    pagination: {
      page,
      limit,
      total: totalCount,
      total_pages: Math.ceil(totalCount / limit),
    },
  }), { state, computedAt });
});

function feedbackEntry(doc: FeedbackDocument, titles: Map<string, string>) {
  const VALUE_LABELS: Record<string, string> = {
    thumbs_up: 'Thumbs up',
    thumbs_down: 'Thumbs down',
    wrong_answer: 'Wrong answer',
    needs_detail: 'Needs detail',
    too_verbose: 'Too verbose',
    retry: 'Retry',
    other: 'Other',
  };

  const valueLabel = VALUE_LABELS[doc.value] || doc.value || null;
  const comment = doc.comment || null;
  // Combine value and comment: "Wrong answer; check the team..."
  // Skip generic thumbs_up/thumbs_down labels when there's no comment
  const isGenericValue = doc.value === 'thumbs_up' || doc.value === 'thumbs_down';
  let reason: string | null = null;
  if (valueLabel && comment) {
    reason = isGenericValue ? comment : `${valueLabel}; ${comment}`;
  } else if (comment) {
    reason = comment;
  } else if (valueLabel && !isGenericValue) {
    reason = valueLabel;
  }

  return {
    message_id: doc.message_id || doc._id?.toString(),
    conversation_id: doc.conversation_id || null,
    conversation_title: titles.get(doc.conversation_id ?? '') || undefined,
    source: doc.source || 'web',
    channel_name: doc.channel_name || null,
    rating: doc.rating,
    reason,
    submitted_by: doc.user_email || doc.user_id || 'unknown',
    submitted_at: doc.created_at instanceof Date ? doc.created_at.toISOString() : doc.created_at,
    trace_id: doc.trace_id || null,
    slack_permalink: doc.slack_permalink || null,
  };
}
