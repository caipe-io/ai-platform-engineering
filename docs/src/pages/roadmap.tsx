import React from 'react';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import styles from './roadmap.module.css';

const ROADMAP = [
  {
    title: 'Comprehensive Human and Non-human Identity and RBAC',
    description: 'Role and team-based access control touching all features — OAuth 2.1, audit logs, and channel-to-agent assignment.',
    status: 'in-progress',
    subItems: [
      'OAuth 2.1 features: DCR, Token Exchange, three-legged auth for remote MCP servers',
      'Manage RBAC user/teams/roles from UI',
      'Assign Slack/Webex channels ↔ Custom agents',
      'Detailed authorization audit logs (OBO agent actor logs)',
      'Two-tier policy system for self-service workflow tool authorization',
    ],
    issueRefs: ['#1742'],
  },
  {
    title: 'Amazon Bedrock AgentCore Integration',
    description: 'Integrate Amazon Bedrock AgentCore as a managed runtime backend for CAIPE Dynamic Agents — enabling AWS-native teams to run, scale, and observe agents using AgentCore\'s managed infrastructure, memory, and tool execution environment.',
    status: 'planned',
    subItems: [
      'AgentCore runtime adapter for the Dynamic Agents harness',
      'Agent lifecycle mapping: create / invoke / delete AgentCore agents from CAIPE UI',
      'Memory bridge: sync AgentCore session memory with CAIPE conversation context',
      'Tool execution: route MCP tool calls through AgentCore\'s tool executor',
      'IAM role-based auth for AgentCore API calls',
      'Surface AgentCore traces and logs in CAIPE AgentOps',
    ],
    issueRefs: ['#2109'],
  },
  {
    title: 'Multiple Agentic Harness SDK Integration',
    description: 'Support multiple agentic harness SDKs — ADK, Strands, Claude SDK — so teams can bring their preferred agent framework without being locked into a single runtime.',
    status: 'planned',
    subItems: [
      'Google ADK (Agent Development Kit) adapter',
      'AWS Strands SDK adapter',
      'Anthropic Claude SDK adapter',
      'Pluggable harness adapter architecture — swap frameworks per agent',
    ],
    issueRefs: ['#2079'],
  },
  {
    title: 'LLM Budget & Quota Management',
    description: 'Per-user and per-agent LLM token budget enforcement using LiteLLM keys — track spend, set quotas, and prevent runaway inference costs.',
    status: 'planned',
    subItems: [
      'LiteLLM key integration for per-agent token tracking',
      'Dynamic LLM key creation for dynamic agents',
      'Budget dashboards and quota alerts in the admin UI',
    ],
    issueRefs: ['#2080'],
  },
  {
    title: 'Automatic Agentic Evaluation',
    description: 'Automated evaluation pipeline for agent response quality — deepeval-based RAG precision/recall, F1 scoring, and a self-improving feedback loop that tightens agent accuracy over time.',
    status: 'planned',
    subItems: [
      'deepeval pipeline: RAG precision, recall, F1 scoring',
      'Agent response quality scoring (relevance, faithfulness, context recall)',
      'CI quality gate: fail on regression below threshold',
      'Self-improving feedback loop',
    ],
    issueRefs: ['#2081'],
  },
  {
    title: 'Agent Sandbox Execution',
    description: 'Isolated sandbox environments that let teams test agents safely without touching production data, credentials, or systems.',
    status: 'planned',
    subItems: [
      'Sandboxed agent execution with isolated credentials and tool stubs',
      'UI toggle to launch any agent in sandbox mode',
      'Sandbox audit log separate from production',
      'Automatic sandbox teardown after session or TTL',
    ],
    issueRefs: ['#2082'],
  },
  {
    title: 'Agentic Apps with UI Plugin Architecture',
    description: 'A plugin architecture that lets teams ship custom agentic apps — dashboards, workflow surfaces, or full UI panels — and register them into the CAIPE shell without forking the core frontend.',
    status: 'planned',
    subItems: [
      'Plugin manifest spec: name, entrypoint, permissions, nav placement',
      'Sandboxed plugin host in the CAIPE shell (module federation or iframe)',
      'Plugin SDK: invoke agents, stream results, access auth token',
      'Plugin registry UI — install, enable/disable, configure per-team',
      'Reference plugin: SRE Runbook app',
    ],
    issueRefs: ['#2085'],
  },
  {
    title: 'Autonomous Agents',
    description: 'Self-directed agents that proactively monitor, detect, and act on platform events without explicit user prompts.',
    status: 'planned',
    subItems: [
      'Event-driven activation from alerts, webhooks, and scheduled checks',
      'Policy guardrails scoping what actions agents may take without approval',
      'Human-in-the-loop escalation to Slack/Webex when confidence is low',
      'Full autonomous run audit trail',
    ],
    issueRefs: ['#2083'],
  },
  {
    title: 'Agentic SDLC Loops',
    description: 'AI agents integrated throughout the software development lifecycle — from planning and coding to review, testing, and deployment.',
    status: 'planned',
    subItems: [
      'Planning: agent-assisted epic and story decomposition',
      'Coding: PR generation and code-review agent',
      'Testing: test generation and coverage gap detection',
      'Deployment: agent-driven GitOps promotion with health verification',
      'Feedback loop: deployment outcome feeds back to planning metrics',
    ],
    issueRefs: ['#2084'],
  },
];

const STATUS_LABELS: Record<string, {label: string; className: string}> = {
  planned: { label: 'Planned', className: styles.statusPlanned },
  'in-progress': { label: 'In Progress', className: styles.statusInProgress },
  done: { label: 'Done', className: styles.statusDone },
};

export default function RoadmapPage() {
  return (
    <Layout
      title="Roadmap · CAIPE"
      description="CAIPE planned roadmap — upcoming features and improvements for the community AI platform engineering project."
    >
      <main>
        <section className={styles.hero}>
          <div className={styles.heroInner}>
            <Heading as="h1" className={styles.heroTitle}>
              CAIPE Roadmap
            </Heading>
            <p className={styles.heroSubtitle}>
              What we're working on next. The roadmap is driven by the community —
              vote on issues, open feature requests, or join the weekly meeting to
              influence priorities.
            </p>
            <div className={styles.heroCtas}>
              <Link
                className={styles.primaryBtn}
                href="https://github.com/orgs/cnoe-io/projects/9"
              >
                View on GitHub Projects ↗
              </Link>
              <Link className={styles.secondaryBtn} to="/community">
                Join the Community
              </Link>
              <Link className={styles.secondaryBtn} to="/docs/repo-ops/issue-triage">
                Live Issue Classification →
              </Link>
            </div>
          </div>
        </section>

        <section className={styles.list}>
          <div className={styles.listInner}>
            {ROADMAP.map((item, i) => {
              const status = STATUS_LABELS[item.status];
              return (
                <div key={item.title} className={styles.item}>
                  <div className={styles.itemNumber}>{String(i + 1).padStart(2, '0')}</div>
                  <div className={styles.itemContent}>
                    <div className={styles.itemHeader}>
                      <Heading as="h2" className={styles.itemTitle}>{item.title}</Heading>
                      <span className={`${styles.statusBadge} ${status.className}`}>
                        {status.label}
                      </span>
                    </div>
                    <p className={styles.itemDesc}>{item.description}</p>
                    {item.subItems && (
                      <ul className={styles.subItems}>
                        {item.subItems.map((s) => (
                          <li key={s} className={styles.subItem}>{s}</li>
                        ))}
                      </ul>
                    )}
                    {(item as any).issueRefs && (
                      <div className={styles.issueRefs}>
                        {(item as any).issueRefs.map((ref: string) => (
                          <a
                            key={ref}
                            href={`https://github.com/caipe-io/ai-platform-engineering/issues/${ref.replace('#', '')}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={styles.issueRef}
                          >
                            {ref}
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className={styles.contribute}>
          <div className={styles.contributeInner}>
            <Heading as="h2" className={styles.contributeTitle}>
              Shape the roadmap
            </Heading>
            <p className={styles.contributeDesc}>
              CAIPE is community-driven. Open a GitHub issue to suggest a feature,
              comment on existing issues to upvote, or join the weekly Monday
              community meeting to discuss priorities directly.
            </p>
            <div className={styles.heroCtas}>
              <Link
                className={styles.primaryBtn}
                href="https://github.com/caipe-io/ai-platform-engineering/issues/new?template=feature_request.yml"
              >
                Request a Feature ↗
              </Link>
              <Link className={styles.secondaryBtn} to="/community">
                Weekly Meeting →
              </Link>
            </div>
          </div>
        </section>
      </main>
    </Layout>
  );
}
