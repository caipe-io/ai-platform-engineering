import React from 'react';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import styles from './roadmap.module.css';

const ROADMAP = [
  {
    title: 'Identity, Authorization, Credentials, and Audit',
    description: 'CAIPE already provides human and non-human identity, fine-grained authorization, credential management, and audit capabilities across much of the platform. Work continues to extend their coverage and strengthen delegated access and policy enforcement.',
    status: 'in-progress',
    subItems: [
      'Extend OAuth 2.1 support for DCR, token exchange, and delegated access to remote MCP servers',
      'Expand consistent policy enforcement across agents, tools, workflows, knowledge, and channels',
      'Strengthen human and agent actor attribution in authorization audit records',
      'Improve self-service administration for users, teams, roles, credentials, and resource relationships',
    ],
    issueRefs: ['#1742'],
  },
  {
    title: 'Portable Agent Runtimes and Pluggable Harnesses',
    description: 'Work is underway to let teams use different upstream agent frameworks and managed runtimes through common CAIPE lifecycle, tool, memory, streaming, policy, and observability contracts.',
    status: 'in-progress',
    subItems: [
      'Amazon Bedrock AgentCore integration for managed execution',
      'Anthropic Claude Agent SDK adapter',
      'AWS Strands Agents SDK adapter',
      'Per-agent harness and execution-provider selection',
      'Shared compatibility tests, migration guidance, and adapter documentation',
    ],
    issueRefs: ['#2079', '#2109'],
  },
  {
    title: 'Autonomous and Scheduled Agents',
    description: 'The first phase of scheduled and event-driven agent execution is implemented. The next phase focuses on safely governing autonomous actions and making runs easier to operate.',
    status: 'in-progress',
    subItems: [
      'Policy guardrails that constrain actions agents may take without approval',
      'Human-in-the-loop pause and escalation through Slack and Webex',
      'Confidence thresholds and safe failure behavior',
      'Expanded audit trails and operational controls for schedules and event subscriptions',
    ],
    issueRefs: ['#2083'],
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
    description: 'Automated evaluation of retrieval and agent response quality, with measurable signals and regression gates for changes to agents, models, prompts, and knowledge sources.',
    status: 'planned',
    subItems: [
      'deepeval pipeline: RAG precision, recall, F1 scoring',
      'Agent response quality scoring (relevance, faithfulness, context recall)',
      'CI quality gate: fail on regression below threshold',
      'Feedback signals for human-governed improvement of agents and knowledge',
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
      description="Implemented foundations, active work, and planned initiatives on the CAIPE project roadmap."
    >
      <main>
        <section className={styles.hero}>
          <div className={styles.heroInner}>
            <Heading as="h1" className={styles.heroTitle}>
              CAIPE Roadmap
            </Heading>
            <p className={styles.heroSubtitle}>
              See what CAIPE has established, what is underway, and what is planned
              next. Vote on issues, open feature requests, or join the weekly community
              meeting to influence priorities.
            </p>
            <div className={styles.heroCtas}>
              <Link
                className={styles.primaryBtn}
                href="https://github.com/orgs/caipe-io/projects/1/views/5"
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
