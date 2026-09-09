import React from 'react';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import styles from './features.module.css';

const FEATURE_DEMOS = [
  {
    title: 'Agent Builder',
    description: 'Configure agents, tools, knowledge, skills, and runtime guardrails from one guided workspace.',
    gif: 'https://raw.githubusercontent.com/wiki/caipe-io/ai-platform-engineering/agent-builder-demo.gif',
    embed: 'https://app.vidcast.io/share/embed/70f22189-0a44-42d3-b601-b5730504a8e3?disableAMA=1',
    vidcast: 'https://app.vidcast.io/share/70f22189-0a44-42d3-b601-b5730504a8e3',
    alt: 'Agent Builder demo showing agent configuration steps',
  },
  {
    title: 'Knowledge Bases',
    description: 'Ingest sources, search governed content, and organize reusable collections for agents.',
    gif: 'https://raw.githubusercontent.com/wiki/caipe-io/ai-platform-engineering/knowledge-bases-demo.gif',
    embed: 'https://app.vidcast.io/share/embed/e4c72165-7164-4dde-9e3d-7f0087b6bc13?disableAMA=1',
    vidcast: 'https://app.vidcast.io/share/e4c72165-7164-4dde-9e3d-7f0087b6bc13',
    alt: 'Knowledge Bases demo showing data sources, search, and collections',
  },
];

const FEATURES = [
  {
    title: 'Agent Builder',
    icon: '🛠️',
    color: '#0284c7',
    to: '/docs/features/agent-builder',
    items: [
      'Six-step builder for identity, instructions, tools, knowledge, skills, and advanced controls',
      'Configured models, MCP tools, built-in tools, data sources, and collections',
      'Subagents, workflows, middleware, and human approval rules',
      'Team ownership and global sharing with RBAC enforcement',
      'Test in chat, clone, export, or bootstrap agents through Helm',
    ],
  },
  {
    title: 'Workflows',
    icon: '🔁',
    color: '#0d9488',
    to: '/docs/features/workflows',
    items: [
      'Ordered agent steps with per-step prompts and optional capability overrides',
      'Jinja-compatible context from previous steps and run input',
      'Abort, skip, or retry failed steps; pause for human input or approval',
      'Persistent run timelines, tool events, statuses, and artifacts',
      'Start runs from the UI, an agent with workflow access, or the REST API',
    ],
  },
  {
    title: 'BYO Agents & MCP Servers',
    icon: '🔌',
    color: '#7c3aed',
    to: '/docs/development/',
    items: [
      'Deploy code-defined agents and connect external MCP servers',
      'appConfig.mcp_servers — plug in external MCP servers at chart install time',
      'Per-tool MCP servers for each integration',
      'Supported MCP transports: stdio, SSE, and Streamable HTTP',
      'Credential sources: secret refs, caller tokens, and provider connections',
      'LiteLLM proxy support — any LLM provider through a single endpoint',
    ],
  },
  {
    title: 'Credentials & Secrets',
    icon: '🔑',
    color: '#0d9488',
    to: '/docs/ui/features',
    items: [
      'Connected Apps — link Atlassian, GitHub, GitLab, PagerDuty, and Webex for user-scoped MCP access',
      'Connection health, reconnect, and permission review from one Credentials page',
      'Saved Secrets — store bearer tokens and other secret types without showing values again',
      'Rotate, share, and revoke secrets with team-scoped RBAC',
      'Server-side credential retrieval for agents and MCP servers — raw secrets never return to the browser',
    ],
  },
  {
    title: 'Multi-Agent Orchestration',
    icon: '🤖',
    color: '#0284c7',
    to: '/docs/agents/',
    items: [
      'Multi-agent and deep agent interactions with access to multiple tools and sub-agents based on customizable system prompts',
      '10+ first-party curated sub-agents and MCP servers',
      'Ability to create custom Agents',
      'Ability to customize system prompts',
      '[Middleware] Custom Skills Integration',
    ],
  },
  {
    title: 'Rich Web UI',
    icon: '🎨',
    color: '#7c3aed',
    items: [
      'Rich/Contextual Home Page',
      'Rich Chat Interface with live agent/tool status via streaming',
      'Share chat with teams · Archive/Delete chats',
      'Agent Builder',
      'Skills Gateway — AI Assist, API access, security scanner, GitHub crawling',
    ],
  },
  {
    title: 'Knowledge Bases',
    icon: '🧠',
    color: '#0891b2',
    to: '/docs/knowledge_bases/',
    items: [
      'Self-service file, web, and collaboration data sources',
      'Deployment-managed infrastructure ingestors',
      'Hybrid semantic and keyword retrieval with optional Graph RAG',
      'Ownership and search access enforced through OIDC and OpenFGA',
      'Reusable collections and MCP tools for search, fetch, discovery, and graph exploration',
    ],
  },
  {
    title: 'Agent Memory',
    icon: '💾',
    color: '#059669',
    to: '/docs/api/chat-conversations',
    items: [
      'Chat persistence memory with multi-turn conversation',
      'Fact extraction across chats for a user',
    ],
  },
  {
    title: 'Scheduled Runs & External Triggers',
    icon: '📡',
    color: '#d97706',
    to: '/docs/architecture/autonomous-agents',
    items: [
      'Webhook-based agent triggers for event-driven workflows',
      'Scheduled/cron-based agent runs',
      'Integration with alerting systems (PagerDuty, VictorOps, Splunk)',
      'Event stream consumption — trigger agents from platform events',
    ],
  },
  {
    title: 'Agent and Tool Communications',
    icon: '🔗',
    color: '#d97706',
    to: '/docs/api/dynamic-agents-mcp',
    items: [
      'MCP (Model Context Protocol)',
      'Dynamic Agents API',
      'AG-UI / SSE streaming — real-time event handling across all agent types',
      'CLI access',
    ],
  },
  {
    title: 'Enterprise Security',
    icon: '🔒',
    color: '#dc2626',
    to: '/docs/security/',
    items: [
      'OAuth 2.0 integration with OIDC compatible IdPs',
      'OIDC/Okta groups base RBAC',
      'Team based access',
      'Policy based tool restrictions',
    ],
  },
  {
    title: 'Deployment',
    icon: '🚀',
    color: '#2563eb',
    to: '/docs/installation/',
    items: [
      'Kubernetes based Helm charts',
      'Docker/Containerized Agents and MCP servers',
      'Docker Compose support',
      'Secrets management using ExternalSecrets',
      'LLM Tracing integration (Langfuse)',
      'Prometheus Metrics and Analytics',
    ],
  },
  {
    title: 'Integrations',
    icon: '🔌',
    color: '#0891b2',
    to: '/docs/getting-started/user-interfaces',
    items: [
      'Web UI — rich chat interface with live agent/tool status via streaming',
      'Slack Bot — conversational interface for your team\'s existing workflow',
      'Webex Bot — enterprise messaging integration',
      'Chat CLI — invoke any agent from the terminal',
    ],
  },
];

export default function FeaturesPage() {
  const {siteConfig} = useDocusaurusContext();
  const currentDocsPrefix = siteConfig.customFields?.currentDocsPrefix ?? '/docs';

  return (
    <Layout
      title="Features · CAIPE"
      description="Full feature list for CAIPE — multi-agent orchestration, rich web UI, knowledge bases, enterprise security, and more."
    >
      <main>
        <section className={styles.hero}>
          <div className={styles.heroInner}>
            <Heading as="h1" className={styles.heroTitle}>
              CAIPE Features
            </Heading>
            <p className={styles.heroSubtitle}>
              Everything you need to run AI-powered platform engineering at
              enterprise scale — from multi-agent orchestration to RAG knowledge
              bases, skills, and production-grade deployment.
            </p>
            <div className={styles.heroCtas}>
              <Link className={styles.primaryBtn} to="/docs/getting-started/quick-start">
                Get Started →
              </Link>
              <Link className={styles.secondaryBtn} to="/roadmap">
                View Roadmap
              </Link>
              <Link
                className={styles.secondaryBtn}
                href="https://github.com/caipe-io/ai-platform-engineering/issues/new?labels=enhancement&template=feature_request.md"
              >
                Submit a Feature Request ↗
              </Link>
            </div>
          </div>
        </section>

        <section className={styles.demos}>
          <div className={styles.demosInner}>
            <div className={styles.demosHeader}>
              <Heading as="h2" className={styles.demosTitle}>See it in action</Heading>
              <p className={styles.demosSubtitle}>
                Explore the two workflows that make CAIPE useful from the first day.
              </p>
            </div>
            <div className={styles.demoGrid}>
              {FEATURE_DEMOS.map((demo) => {
                const docsPath = demo.title === 'Agent Builder'
                  ? `${currentDocsPrefix}/features/agent-builder`
                  : `${currentDocsPrefix}/knowledge_bases/`;
                return (
                  <article key={demo.title} className={styles.demoCard}>
                    <div className={styles.demoCopy}>
                      <Heading as="h3" className={styles.demoTitle}>{demo.title}</Heading>
                      <p className={styles.demoDescription}>{demo.description}</p>
                    </div>
                    <a href={demo.vidcast} className={styles.demoPreview}>
                      <img src={demo.gif} alt={demo.alt} loading="lazy" />
                      <span className={styles.demoPreviewLabel}>Open full demo ↗</span>
                    </a>
                    <div className={styles.demoEmbed}>
                      <iframe
                        src={demo.embed}
                        title={`${demo.title} Vidcast demo`}
                        loading="lazy"
                        allow="fullscreen *;autoplay *;clipboard-write *;"
                      />
                    </div>
                    <div className={styles.demoActions}>
                      <Link className={styles.demoDocsLink} to={docsPath}>Read the docs →</Link>
                      <a className={styles.demoVidcastLink} href={demo.vidcast}>Watch on Vidcast ↗</a>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        <section className={styles.grid}>
          <div className={styles.gridInner}>
            {FEATURES.map((f) => {
              const target = f.title === 'Agent Builder'
                ? `${currentDocsPrefix}/features/agent-builder`
                : f.to;
              const card = (
                <div key={f.title} className={styles.card} style={target ? {cursor: 'pointer'} : undefined}>
                  <div className={styles.cardHeader} style={{'--card-color': f.color} as React.CSSProperties}>
                    <span className={styles.cardIcon}>{f.icon}</span>
                    <Heading as="h2" className={styles.cardTitle}>{f.title}</Heading>
                  </div>
                  <ul className={styles.cardList}>
                    {f.items.map((item) => (
                      <li key={item} className={styles.cardItem}>{item}</li>
                    ))}
                  </ul>
                </div>
              );
              return target
                ? <Link key={f.title} to={target} style={{textDecoration: 'none', color: 'inherit'}}>{card}</Link>
                : card;
            })}
          </div>
        </section>

        <section className={styles.cta}>
          <Heading as="h2" className={styles.ctaTitle}>Ready to get started?</Heading>
          <p className={styles.ctaSubtitle}>Deploy CAIPE in your environment in minutes.</p>
          <div className={styles.heroCtas}>
            <Link className={styles.primaryBtn} to="/docs/installation">
              Installation Guide →
            </Link>
            <Link className={styles.secondaryBtn} href="https://github.com/caipe-io/ai-platform-engineering">
              GitHub ↗
            </Link>
            <Link
              className={styles.secondaryBtn}
              href="https://github.com/caipe-io/ai-platform-engineering/issues/new?labels=enhancement&template=feature_request.md"
            >
              Submit a Feature Request ↗
            </Link>
          </div>
        </section>
      </main>
    </Layout>
  );
}
