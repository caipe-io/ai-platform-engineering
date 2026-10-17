// GET /api/admin/stats/skills - Platform-wide skill metrics (admin only)

import {
getAuthFromBearerOrSession,
requireRbacPermission,
successResponse,
withErrorHandler,
} from '@/lib/api-middleware';
import { getCollection,isMongoDBConfigured } from '@/lib/mongodb';
import { INSIGHTS_QUERY_TIMEOUT_MS, withInsightsResponseCache } from '@/lib/insights-cache';
import { ApiError } from '@/lib/api-error';
import { resolveAuthorizedAdminSimulationScope, simulationSubjectCanManageAdminSurface } from '@/lib/rbac/admin-simulation-server';
import { resolveInsightsUserFilter } from '@/lib/rbac/insights-user-filter';
import type { AgentSkill } from '@/types/agent-skill';
import type { WorkflowRun } from '@/types/workflow-run';
import type { Document } from 'mongodb';
import { NextRequest,NextResponse } from 'next/server';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function parseRangeBounds(searchParams: URLSearchParams): { rangeStart: Date; rangeEnd: Date } {
  const now = new Date();
  const fromParam = searchParams.get('from');
  const toParam = searchParams.get('to');
  if (fromParam) {
    return {
      rangeStart: new Date(fromParam),
      rangeEnd: toParam ? new Date(toParam) : now,
    };
  }

  const rangeMs = (() => {
    switch (searchParams.get('range')) {
      case '1h': return HOUR_MS;
      case '12h': return 12 * HOUR_MS;
      case '24h':
      case '1d': return DAY_MS;
      case '7d': return 7 * DAY_MS;
      case '90d': return 90 * DAY_MS;
      case '30d':
      default: return 30 * DAY_MS;
    }
  })();
  return { rangeStart: new Date(now.getTime() - rangeMs), rangeEnd: now };
}

export const GET = withErrorHandler(async (request: NextRequest) => {
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
  await requireRbacPermission(session, 'admin_ui', 'view');
  const simulationScope = await resolveAuthorizedAdminSimulationScope(request.nextUrl.searchParams, session);
  if (simulationScope && !(await simulationSubjectCanManageAdminSurface(simulationScope, 'stats'))) {
    throw new ApiError('Platform-wide skill metrics require admin access', 403);
  }

  return withInsightsResponseCache(request, 'insights.skills', {
    fullAdmin: true,
    simulation: simulationScope?.openfgaUser ?? null,
  }, async () => {
    const configs = await getCollection<AgentSkill>('agent_skills');
    const runs = await getCollection<WorkflowRun>('workflow_runs');
    const { searchParams } = request.nextUrl;
    const { rangeStart, rangeEnd } = parseRangeBounds(searchParams);
    const dateMatch = { $gte: rangeStart, $lte: rangeEnd };
    const sourceFilter = searchParams.get('source');
    const { active: hasUserFilter, emails: userEmails } = await resolveInsightsUserFilter(
      searchParams.get('user'),
      searchParams.get('team'),
    );

    // Skill inventory is attributable by creator and creation time. It has no
    // source, Slack-channel, or dynamic-agent axis, so those filters do not
    // apply to the catalog cards.
    const configFilter: Document = { created_at: dateMatch };
    if (hasUserFilter) {
      configFilter.owner_id = userEmails.length === 1 ? userEmails[0] : { $in: userEmails };
    }

    // Legacy skill-run records are web-only and carry owner email + timestamps,
    // but no dynamic-agent/channel attribution. A Slack selection therefore
    // correctly yields zero run metrics while leaving catalog creation metrics.
    const runFilter: Document = { started_at: dateMatch };
    if (hasUserFilter) {
      runFilter.owner_id = userEmails.length === 1 ? userEmails[0] : { $in: userEmails };
    }
    if (sourceFilter === 'slack') runFilter._id = null;

    const allConfigs = await configs.find(configFilter, { maxTimeMS: INSIGHTS_QUERY_TIMEOUT_MS }).toArray();

    const systemSkills = allConfigs.filter((c) => c.is_system).length;
    const userConfigs = allConfigs.filter((c) => !c.is_system);
    const userSkills = userConfigs.length;
    const totalSkills = allConfigs.length;

    const byVisibility = { private: 0, team: 0, global: 0 };
    const categoryMap = new Map<string, number>();
    const creatorMap = new Map<string, number>();

    for (const cfg of userConfigs) {
      const vis = cfg.visibility || 'private';
      if (vis in byVisibility) byVisibility[vis as keyof typeof byVisibility]++;
      categoryMap.set(cfg.category, (categoryMap.get(cfg.category) || 0) + 1);
      creatorMap.set(cfg.owner_id, (creatorMap.get(cfg.owner_id) || 0) + 1);
    }

    const byCategory = Array.from(categoryMap.entries())
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count);

    const topCreators = Array.from(creatorMap.entries())
      .map(([email, count]) => ({ email, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);

    // Creation timeline for the selected range (user-created only).
    const dailyCreatedAgg = await configs
      .aggregate([
        {
          $match: {
            ...configFilter,
            is_system: { $ne: true },
          },
        },
        {
          $group: {
            _id: {
              $dateToString: { format: '%Y-%m-%d', date: '$created_at' },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ], { maxTimeMS: INSIGHTS_QUERY_TIMEOUT_MS })
      .toArray();

    const dailyCreated = dailyCreatedAgg.map((d) => ({
      date: d._id as string,
      count: d.count as number,
    }));

    // Overall run stats
    const overallRunAgg = await runs
      .aggregate([
        { $match: runFilter },
        {
          $group: {
            _id: null,
            total_runs: { $sum: 1 },
            completed: {
              $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] },
            },
            failed: {
              $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] },
            },
            avg_duration_ms: { $avg: '$duration_ms' },
          },
        },
      ], { maxTimeMS: INSIGHTS_QUERY_TIMEOUT_MS })
      .toArray();

    const overallRaw = overallRunAgg[0] || {
      total_runs: 0,
      completed: 0,
      failed: 0,
      avg_duration_ms: null,
    };

    const overallRunStats = {
      total_runs: overallRaw.total_runs as number,
      completed: overallRaw.completed as number,
      failed: overallRaw.failed as number,
      success_rate:
        overallRaw.total_runs > 0
          ? Math.round(
              ((overallRaw.completed as number) / (overallRaw.total_runs as number)) * 100
            )
          : 0,
      avg_duration_ms: overallRaw.avg_duration_ms
        ? Math.round(overallRaw.avg_duration_ms as number)
        : null,
    };

    // Top skills by run count
    const topSkillsAgg = await runs
      .aggregate([
        { $match: runFilter },
        {
          $group: {
            _id: '$workflow_id',
            workflow_name: { $first: '$workflow_name' },
            total_runs: { $sum: 1 },
            completed: {
              $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] },
            },
            failed: {
              $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] },
            },
            last_run: { $max: '$started_at' },
            avg_duration_ms: { $avg: '$duration_ms' },
          },
        },
        { $sort: { total_runs: -1 } },
        { $limit: 15 },
      ], { maxTimeMS: INSIGHTS_QUERY_TIMEOUT_MS })
      .toArray();

    const nameMap = new Map(allConfigs.map((c) => [c.id, c.name]));

    const topSkillsByRuns = topSkillsAgg.map((r) => ({
      skill_id: r._id as string,
      skill_name: nameMap.get(r._id as string) || (r.workflow_name as string) || 'Unknown',
      total_runs: r.total_runs as number,
      completed: r.completed as number,
      failed: r.failed as number,
      success_rate:
        r.total_runs > 0
          ? Math.round(((r.completed as number) / (r.total_runs as number)) * 100)
          : 0,
      last_run: r.last_run ? new Date(r.last_run as string).toISOString() : null,
      avg_duration_ms: r.avg_duration_ms ? Math.round(r.avg_duration_ms as number) : null,
    }));

    return successResponse({
      total_skills: totalSkills,
      system_skills: systemSkills,
      user_skills: userSkills,
      by_visibility: byVisibility,
      by_category: byCategory,
      top_creators: topCreators,
      daily_created: dailyCreated,
      top_skills_by_runs: topSkillsByRuns,
      overall_run_stats: overallRunStats,
    });
  });
});
