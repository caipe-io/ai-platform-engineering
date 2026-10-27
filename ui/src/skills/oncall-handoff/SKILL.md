---
name: oncall-handoff
description: Generate a comprehensive on-call handoff document by aggregating open incidents, ongoing issues, recent deployments, and systems to watch. Orchestrates Splunk On-Call (VictorOps), Jira, and ArgoCD agents. Use during on-call rotation changes or shift handoffs.
---

# On-Call Handoff

Build a structured handoff document for the incoming on-call engineer by collecting data from Splunk On-Call (VictorOps), Jira, and ArgoCD.

### Source of Truth

Splunk On-Call (VictorOps) is the authoritative source for live on-call and alerting data. Use the VictorOps tools for current incidents, resolved incidents, schedules, rotations, escalation policies, teams, users, services, and routing keys. Do not use PagerDuty or a Backstage roster for live on-call state; PagerDuty is historical migration context only. If a VictorOps call fails, report the actual tool error instead of claiming that PagerDuty access is required.

## Instructions

### Phase 1: Current Incident State (Splunk On-Call/VictorOps Agent)
1. **Active incidents** - all triggered and acknowledged incidents
2. **Recently resolved incidents** - resolved in the last 24 hours (may recur)
3. **Current on-call schedule** - who is on-call now, who is taking over
4. **Upcoming maintenance windows** - scheduled within the next 48 hours

### Phase 2: Ongoing Issues (Jira Agent)
1. **Open incident tickets** - Jira issues labeled `incident`, `outage`, `p0`, `p1`
2. **Known issues** - issues labeled `known-issue` or `workaround`
3. **Recently closed issues** - resolved in last 48 hours that may have follow-ups
4. **Pending changes** - tickets in "Ready for Deploy" or "In Review" status

### Phase 3: Environment State (ArgoCD Agent)
1. **Recent deployments** - applications synced in the last 48 hours
2. **Unhealthy applications** - any OutOfSync, Degraded, or Unknown apps
3. **Pending syncs** - applications with pending changes not yet deployed
4. **Recent rollbacks** - any applications that were rolled back

### Phase 4: Compile Handoff Document
Organize all data into a structured, scannable document with clear action items.

## Output Format

```markdown
## On-Call Handoff Document
**Date**: February 9, 2026
**Outgoing**: @engineer-a (Feb 3 - Feb 9)
**Incoming**: @engineer-b (Feb 9 - Feb 16)

---

### Active Incidents (Action Required)
| Incident | Service | Urgency | Duration | Status |
|----------|---------|---------|----------|--------|
| INC-789 | auth-service | High | 2h 15m | Acknowledged |

**INC-789 Context**: Auth service intermittent 503 errors. Root cause suspected to be database connection pool exhaustion. DBA team engaged. Workaround: restart auth-service pods if error rate exceeds 10%.

### Recently Resolved (Watch For Recurrence)
| Incident | Service | Resolved | Duration | Root Cause |
|----------|---------|----------|----------|------------|
| INC-785 | payment-api | Feb 8 18:00 | 45m | Memory leak in v2.3.1 |

### Known Issues & Workarounds
1. **AUTH-456**: Auth service connection pool - restart pods if needed (ETA fix: Feb 12)
2. **PLAT-789**: Flaky integration tests - ignore `test_streaming` failures (known issue)

### Recent Deployments (Last 48h)
| Application | Version | Deployed | Status |
|-------------|---------|----------|--------|
| payment-api | v2.3.2 (hotfix) | Feb 8 19:00 | Healthy |
| auth-service | v1.8.0 | Feb 7 14:00 | Degraded |

### Unhealthy Applications
| Application | Sync Status | Health | Since |
|-------------|-------------|--------|-------|
| auth-service | Synced | Degraded | Feb 8 16:00 |

### Pending Changes (Not Yet Deployed)
- **monitoring-stack**: Prometheus alerting rule updates (PR #234 approved)
- **api-gateway**: Rate limiting config change (scheduled for Feb 10)

### Systems to Watch
1. **auth-service** - Connection pool issue ongoing, monitor error rates
2. **payment-api** - Hotfix deployed yesterday, watch for regression
3. **EKS cluster-prod** - Node scaling event expected during peak hours (10am-2pm)

### Escalation Contacts
| Team | Primary | Secondary |
|------|---------|-----------|
| Platform | @engineer-c | @engineer-d |
| DBA | @dba-primary | @dba-secondary |
| Security | @sec-oncall | - |
```

## Examples

- "Generate an on-call handoff document"
- "Prepare a shift handoff for the incoming on-call engineer"
- "What should the next on-call person know about?"
- "Summarize the current state of production for handoff"

## Guidelines

- Prioritize actionable information - what does the incoming engineer need to DO?
- Include workarounds for known issues so the incoming engineer does not have to search
- Mark items as "action required" vs "monitor" vs "FYI" for clear prioritization
- Always include escalation contacts with team context
- Keep the last 48 hours as the default lookback window for context
- If no active incidents exist, say so explicitly (this is good news)
- Include any scheduled maintenance that falls within the on-call period
