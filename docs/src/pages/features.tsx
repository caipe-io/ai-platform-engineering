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
    vidcast: 'https://app.vidcast.io/share/70f22189-0a44-42d3-b601-b5730504a8e3',
    alt: 'Agent Builder demo showing agent configuration steps',
  },
  {
    title: 'Knowledge Bases',
    description: 'Ingest sources, search governed content, and organize reusable collections for agents.',
    gif: 'https://raw.githubusercontent.com/wiki/caipe-io/ai-platform-engineering/knowledge-bases-demo.gif',
    vidcast: 'https://app.vidcast.io/share/e4c72165-7164-4dde-9e3d-7f0087b6bc13',
    alt: 'Knowledge Bases demo showing data sources, search, and collections',
  },
];

const FEATURES = [
  {
    title: 'Harness Engine & Harness Gateway',
    icon: '⚡',
    since: '1.4.0',
    color: '#0284c7',
    to: '/docs/features/harness-runtimes',
    items: [
      'LangChain Deep Agents — stable runtime with tools, skills, and subagents',
      'Claude Agent SDK — experimental support for local execution or a remote worker',
      'Claude Code remote agents — use a configured Claude Code CLI worker over ACP (experimental)',
      'Amazon Bedrock AgentCore — connect an existing deployment for remote sessions (experimental)',
      'Persist sessions and replay events for runs that continue after a client disconnects',
      'Use the existing CAIPE chat experience with Harness-backed agents',
      'Enable Harness Gateway transport for Slack and Webex',
    ],
  },
  {
    title: 'Enterprise-Grade Security',
    icon: '🔒',
    since: '0.5.x',
    color: '#dc2626',
    to: '/docs/security/rbac/architecture',
    items: [
      'Single sign-on with Keycloak and OIDC identity providers',
      'Fine-grained OpenFGA authorization for agents, tools, and knowledge bases',
      'Scoped, team-owned service accounts and encrypted credential storage',
      'Caller-scoped MCP access through AgentGateway, with authorization audit records',
      'Human approval steps for sensitive workflow actions',
    ],
  },
  {
    title: 'Agent Builder',
    icon: '🛠️',
    since: '0.5.x',
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
    since: '0.5.x',
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
    since: '0.2.x',
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
    title: 'Agentic Apps',
    icon: '🧩',
    since: '1.3.0',
    color: '#9333ea',
    to: '/docs/features/agentic-apps',
    items: [
      'Launch hosted and native apps from the CAIPE Apps catalog',
      'Work with app-owned assistants in the shared chat experience',
      'Reuse the signed-in CAIPE session for app-scoped access',
      'Protect routes with explicit roles and token scopes',
      'Keep app data, UI, and domain authorization independent',
      'Same-origin hosting with a short-lived identity token per request',
    ],
  },
  {
    title: 'Credentials & Secrets',
    icon: '🔑',
    since: '0.5.x',
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
    since: '0.2.x',
    color: '#0284c7',
    to: '/docs/agents/',
    items: [
      'Multi-agent and deep agent interactions with access to multiple tools and sub-agents based on customizable system prompts',
      '10+ first-party curated sub-agents and MCP servers',
      'Create agents with Agent Builder',
      'Ability to customize system prompts',
      '[Middleware] Custom Skills Integration',
    ],
  },
  {
    title: 'Rich Web UI',
    icon: '🎨',
    since: '1.0.0',
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
    title: 'Skills',
    icon: '🧰',
    since: '0.5.x',
    color: '#7c3aed',
    to: '/docs/features/skills/',
    items: [
      'Browse and reuse focused procedures stored as SKILL.md files',
      'Import, revise, and attach skills to agents',
      'Scan skills for prompt injection and unsafe tool behavior',
      'Use scan gates to warn or block flagged skills',
      'Skills Gateway — create catalog API keys and install skills into supported coding agents',
    ],
  },
  {
    title: 'Settings & Admin',
    icon: '⚙️',
    since: '0.5.x',
    color: '#475569',
    to: '/docs/features/admin-settings',
    items: [
      'Set personal defaults for chat, agents, appearance, and notifications',
      'Review platform health and component status',
      'Manage users, teams, resources, integrations, and credentials',
      'Review audit, metrics, security policy, and migrations',
      'Keep administrative controls separate from personal preferences',
    ],
  },
  {
    title: 'Knowledge Bases',
    icon: '🧠',
    since: '0.4.x',
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
    since: '0.5.x',
    color: '#059669',
    to: '/docs/api/chat-conversations',
    items: [
      'Chat persistence memory with multi-turn conversation',
      'Fact extraction across chats for a user',
    ],
  },
  {
    title: 'Autonomous Agents & Scheduled Runs',
    icon: '📡',
    since: '0.5.x',
    color: '#d97706',
    to: '/docs/architecture/autonomous-agents',
    items: [
      'Run agents on a cron schedule, at fixed intervals, or on demand',
      'Start runs from signed webhooks from supported services',
      'Manage tasks and inspect run history from the Autonomous workspace',
    ],
  },
  {
    title: 'Agent and Tool Communications',
    icon: '🔗',
    since: '0.4.x',
    color: '#d97706',
    to: '/docs/features/remote-agents',
    items: [
      'Agent-to-Agent (A2A) — delegate work to registered remote agents from Agent Builder (since 1.3.0)',
      'Agent Client Protocol (ACP) — chat with configured Claude Agent SDK or Claude Code workers (experimental in 1.4.0)',
      'MCP (Model Context Protocol)',
      'Dynamic Agents API',
      'AG-UI / SSE streaming — real-time event handling across all agent types',
      'CLI access',
    ],
  },
  {
    title: 'Deployment',
    icon: '🚀',
    since: '0.2.x',
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
    since: '0.5.x',
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
  const [selectedDemo, setSelectedDemo] = React.useState<(typeof FEATURE_DEMOS)[number] | null>(null);
  const currentDocsPrefix = siteConfig.customFields?.currentDocsPrefix ?? '/docs';

  const docsPathForDemo = (title: string) => title === 'Agent Builder'
    ? `${currentDocsPrefix}/features/agent-builder`
    : `${currentDocsPrefix}/knowledge_bases/`;

  return (
    <>
      <Layout
      title="Features · CAIPE"
      description="Explore CAIPE support for Deep Agents, Claude Agent SDK, remote Claude Code agents, and Amazon Bedrock AgentCore, with A2A, ACP, and enterprise-grade security."
    >
      <main>
        <section className={styles.hero}>
          <div className={styles.heroInner}>
            <Heading as="h1" className={styles.heroTitle}>
              CAIPE Features
            </Heading>
            <p className={styles.heroSubtitle}>
              Run agents with LangChain Deep Agents or the Claude Agent SDK, and connect remote
              Claude Code agents over ACP and Amazon Bedrock AgentCore deployments.
              Delegate work to registered remote agents over A2A. CAIPE provides
              {' '}<strong>enterprise-grade security</strong> with single sign-on, fine-grained
              authorization, and auditable tool access.
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
                return (
                  <article key={demo.title} className={styles.demoCard}>
                    <div className={styles.demoCopy}>
                      <Heading as="h3" className={styles.demoTitle}>{demo.title}</Heading>
                      <p className={styles.demoDescription}>{demo.description}</p>
                    </div>
                    <button
                      type="button"
                      className={styles.demoPreview}
                      onClick={() => setSelectedDemo(demo)}
                      aria-label={`Open the ${demo.title} demo preview`}
                    >
                      <img src={demo.gif} alt={demo.alt} loading="lazy" />
                      <span className={styles.demoPreviewLabel}>Expand preview ↗</span>
                    </button>
                    <div className={styles.demoActions}>
                      <Link className={styles.demoDocsLink} to={docsPathForDemo(demo.title)}>Read the docs →</Link>
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
                : f.to?.startsWith('/docs/')
                  ? `${currentDocsPrefix}${f.to.slice('/docs'.length)}`
                  : f.to;
              const card = (
                <div key={f.title} className={styles.card} style={target ? {cursor: 'pointer'} : undefined}>
                  <div className={styles.cardHeader} style={{'--card-color': f.color} as React.CSSProperties}>
                    <span className={styles.cardIcon}>{f.icon}</span>
                    <div>
                      <Heading as="h2" className={styles.cardTitle}>{f.title}</Heading>
                      <span className={styles.cardSince}>Since {f.since}</span>
                    </div>
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
      {selectedDemo && (
        <DemoLightbox
          demo={selectedDemo}
          docsPath={docsPathForDemo(selectedDemo.title)}
          onClose={() => setSelectedDemo(null)}
        />
      )}
    </>
  );
}

function DemoLightbox({
  demo,
  docsPath,
  onClose,
}: {
  demo: (typeof FEATURE_DEMOS)[number];
  docsPath: string;
  onClose: () => void;
}) {
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div className={styles.demoModalBackdrop} onClick={onClose} role="presentation">
      <div
        className={styles.demoModalDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="feature-demo-title"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className={styles.demoModalClose}
          onClick={onClose}
          aria-label={`Close ${demo.title} demo preview`}
        >
          ×
        </button>
        <img className={styles.demoModalGif} src={demo.gif} alt={demo.alt} />
        <div className={styles.demoModalFooter}>
          <div>
            <Heading as="h2" className={styles.demoModalTitle} id="feature-demo-title">
              {demo.title}
            </Heading>
            <p className={styles.demoModalHint}>Preview the workflow, then watch the complete walkthrough.</p>
          </div>
          <div className={styles.demoModalActions}>
            <Link className={styles.demoDocsLink} to={docsPath}>Read the docs →</Link>
            <a className={styles.demoModalVidcast} href={demo.vidcast} target="_blank" rel="noopener noreferrer">
              Watch the full demo on Vidcast ↗
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
