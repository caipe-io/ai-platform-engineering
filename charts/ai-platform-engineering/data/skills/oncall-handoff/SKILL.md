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
1. **Open incident tickets** - Jira issues labeled \`incident\`, \`outage\`, \`p0\`, \`p1\`
2. **Known issues** - issues labeled \`known-issue\` or \`workaround\`
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

\`\`\`markdown
## On-Call Handoff Document
**Date**: February 9, 2026
**Outgoing**: @engineer-a | **Incoming**: @engineer-b

### Active Incidents (Action Required)
| Incident | Service | Urgency | Duration | Status |
|----------|---------|---------|----------|--------|
| INC-789 | auth-service | High | 2h 15m | Acknowledged |

### Systems to Watch
1. **auth-service** - Connection pool issue ongoing
2. **payment-api** - Hotfix deployed yesterday, watch for regression
\`\`\`

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
