import React from 'react';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import styles from './roadmap.module.css';

type RoadmapStatus = 'planned' | 'in-progress' | 'prototype' | 'stretch';
type RoadmapMilestone = '1.5.0' | '2.0.0';

type RoadmapItem = {
  title: string;
  description: string;
  status: RoadmapStatus;
  milestones?: RoadmapMilestone[];
  milestoneScope?: string;
  subItems?: string[];
  issueRefs?: string[];
  links?: { label: string; href: string }[];
};

const REPO_URL = 'https://github.com/caipe-io/ai-platform-engineering';
const MILESTONE_URLS: Record<RoadmapMilestone, string> = {
  '1.5.0': `${REPO_URL}/milestone/25`,
  '2.0.0': `${REPO_URL}/milestone/26`,
};

const ROADMAP: RoadmapItem[] = [
  {
    title: 'CAIPE Authorization Service (CAS) v2',
    description: 'Make CAS the supported authorization boundary across CAIPE services, with Keycloak for identity and OpenFGA for relationship-based access. The 2.0.0 epic builds on the 1.5.0 migration and evaluates CEL, OPA, and Cedar for business policy.',
    status: 'planned',
    milestones: ['2.0.0'],
    links: [
      { label: '2.0.0 CAS v2 epic #2927', href: `${REPO_URL}/issues/2927` },
      { label: '1.5.0 CAS migration #2487', href: `${REPO_URL}/issues/2487` },
      { label: 'OpenFGA policy administration #2561', href: `${REPO_URL}/issues/2561` },
    ],
  },
  {
    title: 'Amazon Bedrock AgentCore Follow-ons',
    description: 'Extend the experimental AgentCore runtime integration with lifecycle management, memory, tool execution, and observability.',
    status: 'planned',
    subItems: [
      'Agent lifecycle mapping: create / invoke / delete AgentCore agents from CAIPE UI',
      'Memory bridge: sync AgentCore session memory with CAIPE conversation context',
      'Tool execution: route MCP tool calls through AgentCore\'s tool executor',
      'IAM role-based auth for AgentCore API calls',
      'Surface AgentCore traces and logs in CAIPE AgentOps',
    ],
    issueRefs: ['#2109'],
  },
  {
    title: 'Harness Engine & Gateway v2',
    description: 'Define how the Harness Gateway and agent runtimes work together, including runtime lifecycle, sandbox integration, and session isolation.',
    status: 'planned',
    milestones: ['2.0.0'],
    links: [
      { label: 'Harness v2 epic #2930', href: `${REPO_URL}/issues/2930` },
    ],
  },
  {
    title: 'LLM Budget Tracking via Gateways',
    description: 'Track LLM usage and enforce budgets through supported gateways. The 1.5.0 epic tracks per-agent budgets and model routing. The 2.0.0 follow-on covers broader policy enforcement and gateway responsibilities.',
    status: 'in-progress',
    milestones: ['1.5.0', '2.0.0'],
    links: [
      { label: '1.5.0 budget epic #2537', href: `${REPO_URL}/issues/2537` },
      { label: '2.0.0 gateway epic #2926', href: `${REPO_URL}/issues/2926` },
    ],
  },
  {
    title: 'Automatic Agentic Evaluation',
    description: 'Automated evaluation pipeline for agent response quality — deepeval-based RAG precision/recall, F1 scoring, and a self-improving feedback loop that tightens agent accuracy over time.',
    status: 'planned',
    milestones: ['1.5.0'],
    milestoneScope: 'RAG Evaluation v1',
    subItems: [
      'deepeval pipeline: RAG precision, recall, F1 scoring',
      'Agent response quality scoring (relevance, faithfulness, context recall)',
      'CI quality gate: fail on regression below threshold',
      'Self-improving feedback loop',
    ],
    issueRefs: ['#2081'],
    links: [
      { label: 'RAG Evaluation v1 epic #2538', href: `${REPO_URL}/issues/2538` },
    ],
  },
  {
    title: 'Agent Sandboxes',
    description: 'Integrate CAIPE Sandbox so teams can test agents in isolated workspaces with separate tools, data, and credentials. The Agent Substrate is a future direction for sandbox execution.',
    status: 'planned',
    milestones: ['2.0.0'],
    milestoneScope: 'Sandbox execution',
    links: [
      { label: 'CAIPE Sandbox', href: 'https://github.com/caipe-io/caipe-sandbox' },
      { label: 'Sandbox execution epic #2082', href: `${REPO_URL}/issues/2082` },
      { label: 'Sandbox v2 epic #2929', href: `${REPO_URL}/issues/2929` },
    ],
  },
  {
    title: 'AgentBridge Integration (A2A)',
    description: 'An isolated prototype connected AgentBridge to CAIPE over A2A. The Direct A2A and Agent Teams epic tracks the broader chat and runtime integration.',
    status: 'prototype',
    milestones: ['1.5.0'],
    milestoneScope: 'Direct A2A',
    links: [
      { label: 'Direct A2A epic #3432', href: `${REPO_URL}/issues/3432` },
      { label: 'AgentBridge prototype PR #3261', href: `${REPO_URL}/pull/3261` },
    ],
  },
  {
    title: 'Agent Teams',
    description: 'Work with multiple agents in one conversation. Add and mention participants, hand off tasks, and combine their contributions into a single response.',
    status: 'planned',
    milestones: ['1.5.0'],
    links: [
      { label: '1.5.0 Agent Teams epic #3432', href: `${REPO_URL}/issues/3432` },
      { label: 'Participant workspace PR #3256', href: `${REPO_URL}/pull/3256` },
    ],
  },
  {
    title: 'Agentic Apps v2',
    description: 'Extend the app platform with runtime UI plugins and a shared manifest contract for native and iframe apps.',
    status: 'planned',
    milestones: ['1.5.0', '2.0.0'],
    links: [
      { label: '1.5.0 Runtime UI Plugins epic #2575', href: `${REPO_URL}/issues/2575` },
      { label: '2.0.0 Manifest v2 epic #2928', href: `${REPO_URL}/issues/2928` },
    ],
  },
  {
    title: 'Notification Framework',
    description: 'The event and preference contracts have landed. The stretch proposal covers reusable notifications for platform and app events, including delivery destinations, user controls, retries, and deduplication.',
    status: 'stretch',
    milestones: ['2.0.0'],
    links: [
      { label: '2.0.0 stretch epic #2934', href: `${REPO_URL}/issues/2934` },
      { label: 'Event and preference contracts PR #2993', href: `${REPO_URL}/pull/2993` },
    ],
  },
  {
    title: 'Autonomous Agents v2',
    description: 'Extend autonomous runs with policy guardrails, human escalation, and expanded audit coverage.',
    status: 'planned',
    links: [
      { label: 'Autonomous Agents v2 epic #2578', href: `${REPO_URL}/issues/2578` },
    ],
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

const STATUS_LABELS: Record<RoadmapStatus, {label: string; className: string}> = {
  planned: { label: 'Planned', className: styles.statusPlanned },
  'in-progress': { label: 'In Progress', className: styles.statusInProgress },
  prototype: { label: 'Prototype', className: styles.statusInProgress },
  stretch: { label: 'Stretch proposal', className: styles.statusPlanned },
};

export default function RoadmapPage() {
  return (
    <Layout
      title="Roadmap · CAIPE"
      description="Explore upcoming features, active work, and proposals for the CAIPE project."
    >
      <main>
        <section className={styles.hero}>
          <div className={styles.heroInner}>
            <Heading as="h1" className={styles.heroTitle}>
              CAIPE Roadmap
            </Heading>
            <p className={styles.heroSubtitle}>
              Explore what we're working on and what's planned. Vote on issues,
              open feature requests, or join the weekly meeting to influence priorities.
            </p>
            <div className={styles.heroCtas}>
              <Link
                className={styles.primaryBtn}
                href="https://github.com/orgs/caipe-io/projects/1"
              >
                View on GitHub Projects ↗
              </Link>
              <Link className={styles.secondaryBtn} to="/features">
                Explore Available Features
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
                      {item.milestones?.map((milestone) => (
                        <a key={milestone} className={styles.milestone} href={MILESTONE_URLS[milestone]}>
                          {milestone} milestone{item.milestoneScope && ` · ${item.milestoneScope}`}
                        </a>
                      ))}
                    </div>
                    <p className={styles.itemDesc}>{item.description}</p>
                    {item.subItems && (
                      <ul className={styles.subItems}>
                        {item.subItems.map((s) => (
                          <li key={s} className={styles.subItem}>{s}</li>
                        ))}
                      </ul>
                    )}
                    {(item.issueRefs || item.links) && (
                      <div className={styles.issueRefs}>
                        {item.issueRefs?.map((ref) => (
                          <a
                            key={ref}
                            href={`${REPO_URL}/issues/${ref.slice(1)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={styles.issueRef}
                          >
                            {ref}
                          </a>
                        ))}
                        {item.links?.map(({ label, href }) => (
                          <a
                            key={href}
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={styles.issueRef}
                          >
                            {label}
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
