import React, { useState, useEffect } from 'react';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import styles from './index.module.css';

const CURL_CMD = 'bash <(curl -fsSL https://raw.githubusercontent.com/caipe-io/ai-platform-engineering/main/setup-caipe.sh)';
const HELM_CMD = 'helm upgrade --install ai-platform-engineering \\\n    oci://ghcr.io/caipe-io/charts/ai-platform-engineering \\\n    --version 1.0.1 -f your-values.yaml';
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={styles.copyBtn}
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? '✓ Copied' : 'Copy'}
    </button>
  );
}

const INSTALL_METHODS = [
  { id: 'curl', label: 'curl', cmd: CURL_CMD },
  { id: 'helm', label: 'Helm', cmd: HELM_CMD },
];

function InstallWidget() {
  const [active, setActive] = useState(0);
  const [copied, setCopied] = useState(false);
  const method = INSTALL_METHODS[active];

  const copy = () => {
    navigator.clipboard.writeText(method.cmd);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={styles.installWidget}>
      <div className={styles.installTabs}>
        {INSTALL_METHODS.map((m, i) => (
          <button
            className={styles.installTab}
            data-active={i === active ? 'true' : 'false'}
            key={m.id}
            onClick={() => { setActive(i); setCopied(false); }}
            type="button"
          >
            {m.label}
          </button>
        ))}
      </div>
      <button
        aria-label={copied ? 'Copied' : 'Copy command'}
        className={styles.installRow}
        onClick={copy}
        type="button"
      >
        <pre className={styles.installPre}>
          <code>
            <span className={styles.codePrompt}>$</span> {method.cmd}
          </code>
        </pre>
        {copied ? (
          <svg className={styles.installIcon} fill="none" height="16" viewBox="0 0 24 24" width="16">
            <path d="M5 13l4 4L19 7" stroke="#4ade80" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
          </svg>
        ) : (
          <svg className={styles.installIcon} fill="none" height="16" viewBox="0 0 24 24" width="16">
            <rect height="13" rx="2" stroke="currentColor" strokeWidth="1.8" width="13" x="8" y="8" />
            <path d="M5 16V5a2 2 0 0 1 2-2h11" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
          </svg>
        )}
      </button>
    </div>
  );
}

const HOME_FEATURES = [
  {
    icon: '🤖',
    title: 'Multi-Agent Orchestration',
    description: 'Dynamic agents connected to first-party and external MCP servers.',
    to: '/features',
  },
  {
    icon: '🎨',
    title: 'Rich Web UI',
    description: 'Streaming chat, Agent Builder, Skills Gateway, and admin controls.',
    to: '/features',
  },
  {
    icon: '🧠',
    title: 'Knowledge Bases',
    description: 'Hybrid RAG and optional Graph RAG across web, AWS, Kubernetes, Jira, GitHub, Slack, and more.',
    to: '/features',
  },
  {
    icon: '💾',
    title: 'Agent Memory',
    description: 'Cross-session fact extraction and per-user context persistence.',
    to: '/features',
  },
  {
    icon: '🔒',
    title: 'Enterprise Security',
    description: 'OIDC SSO, Okta RBAC, and policy-based tool restrictions.',
    to: '/features',
  },
  {
    icon: '🚀',
    title: 'Flexible Deployment',
    description: 'Helm, Docker Compose, Langfuse tracing. Bring any OpenAI-compatible LLM.',
    to: '/features',
  },
  {
    icon: '⚙️',
    title: 'Workflows',
    description: 'Ordered agent steps with persisted run history and artifacts.',
    to: '/features',
  },
  {
    icon: '🛠️',
    title: 'Agent Builder',
    description: 'Build governed agents with configured models, tools, knowledge, and guardrails.',
    to: '/features',
  },
  {
    icon: '🔌',
    title: 'BYO MCP Servers',
    description: 'Plug in external MCP servers and custom Dynamic Agents as first-class participants.',
    to: '/features',
  },
  {
    icon: '🌐',
    title: 'Multi-Model Support',
    description: 'Claude, OpenAI, Gemini, or any compatible endpoint. Swap without rewiring.',
    to: '/features',
  },
  {
    icon: '💻',
    title: 'Multiple Clients',
    description: 'Web UI, Chat CLI, Slack Bot, and Webex Bot.',
    to: '/features',
  },
];

const USE_CASES = [
  {
    title: 'How Splunk Built Forge on CAIPE',
    description:
      'Splunk Cloud Platform team used CAIPE to build an always-on internal AI assistant, cutting engineer response times by 99% and automating support triage across 90+ channels.',
    image: 'https://outshift-headless-cms-s3.s3.us-east-2.amazonaws.com/ai-default-img-1.png',
    href: 'https://outshift.cisco.com/blog/ai-ml/how-splunk-built-forge-on-caipe',
    label: 'Splunk',
    external: true,
  },
  {
    title: 'JARVIS: Multi-Agent System Design Deep Dive',
    description:
      "A technical deep dive into how JARVIS, Cisco's internal platform AI assistant, is architected as a multi-agent system on CAIPE for better performance and scale.",
    image: 'https://outshift-headless-cms-s3.s3.us-east-2.amazonaws.com/CREA-989.png',
    href: 'https://outshift.cisco.com/blog/ai-ml/jarvis-technical-deep-dive-multi-agent-design',
    label: 'Cisco Outshift',
    external: true,
  },
];

const AGENTS = [
  'ArgoCD', 'PagerDuty', 'GitHub', 'GitLab', 'Jira', 'Confluence',
  'Kubernetes', 'Slack', 'Webex', 'Splunk', 'VictorOps', 'Komodor',
  'Backstage', 'AWS', 'Weather',
];

function HeroSection() {
  const [stars, setStars] = useState<string | null>(null);
  useEffect(() => {
    fetch('https://api.github.com/repos/caipe-io/ai-platform-engineering')
      .then((r) => r.json())
      .then((d) => {
        const n = d.stargazers_count;
        if (typeof n === 'number') {
          setStars(n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
        }
      })
      .catch(() => {});
  }, []);
  return (
    <section className={styles.hero}>
      <div className={styles.heroInner}>
        <div className={styles.heroGrid}>
          {/* Left: copy + CTAs */}
          <div className={styles.heroLeft}>
            <Heading as="h1" className={styles.heroTitle}>
              Open Source AI Platform for{' '}
              <span className={styles.heroAccent}>All</span>
            </Heading>
            <p className={styles.heroSubtitle}>
              <span className={styles.heroLine}>
                Build, govern, and operate secure AI agents and agentic workflows
              </span>{' '}
              <span className={styles.heroLine}>for enterprises and individuals</span>
            </p>
            <p className={styles.heroPronunciation}>
              <span className={styles.heroLine}>
                💡 Pronounced like <strong>cape</strong> 🦸 — just as a cape empowers a superhero,
              </span>{' '}
              <span className={styles.heroLine}>
                CAIPE empowers teams with 🤖 agentic AI automation.
              </span>
            </p>
            <div className={styles.heroButtons}>
              <Link className={styles.heroPrimary} to="/docs/getting-started/quick-start">
                Get Started →
              </Link>
              <Link className={styles.heroSecondary} href="https://app.vidcast.io/share/embed/e0033e26-46bf-4298-8c20-0a2fd1746073">
                Watch a Demo ▶
              </Link>
              <Link className={styles.heroSecondary} href="https://github.com/caipe-io/ai-platform-engineering">
                GitHub ↗
              </Link>
            </div>

            <InstallWidget />
          </div>
        </div>

        {/* Stats row */}
        <div className={styles.heroStats}>
          <div className={styles.heroStat}>
            <span className={styles.heroStatNumber}>OSS</span>
            <span className={styles.heroStatLabel}>Apache 2.0</span>
          </div>
          <a
            href="https://github.com/caipe-io/ai-platform-engineering"
            target="_blank"
            rel="noopener noreferrer"
            className={styles.heroStat}
            style={{textDecoration: 'none'}}
          >
            <span className={styles.heroStatNumber}>⭐ {stars ?? '—'}</span>
            <span className={styles.heroStatLabel}>GitHub Stars</span>
          </a>
        </div>
      </div>
    </section>
  );
}

function FeaturesSection() {
  return (
    <section className={styles.features}>
      <div className={styles.sectionHeader}>
        <p className={styles.sectionLabel}>Why CAIPE</p>
        <Heading as="h2" className={styles.sectionTitle}>
          Built for teams of all sizes
        </Heading>
        <p className={styles.sectionSubtitle}>
          Everything you need to run agents in production, plus the controls to
          let your whole team help themselves safely.
        </p>
      </div>
      <div className={styles.featuresGrid}>
        {HOME_FEATURES.map((f) => (
          <Link key={f.title} to={f.to} className={styles.featureCard}>
            <div className={styles.featureCardHeader}>
              <span className={styles.featureIcon}>{f.icon}</span>
              <Heading as="h3" className={styles.featureTitle}>{f.title}</Heading>
            </div>
            <p className={styles.featureDesc}>{f.description}</p>
          </Link>
        ))}
      </div>
      <div className={styles.featuresCta}>
        <Link className={styles.heroPrimary} to="/features">
          Explore all features →
        </Link>
      </div>
    </section>
  );
}

function InTheWildSection() {
  return (
    <section className={styles.inTheWild}>
      <div className={styles.sectionHeader}>
        <p className={styles.sectionLabel}>Real World Usage</p>
        <Heading as="h2" className={styles.sectionTitle}>
          Used in production
        </Heading>
        <p className={styles.sectionSubtitle}>
          Teams building with CAIPE, from always-on AI assistants to platform
          automation at enterprise scale.
        </p>
      </div>
      <div className={styles.useCasesGrid}>
        {USE_CASES.map((uc) => {
          const inner = (
            <>
              <div className={styles.useCaseImg}>
                <img src={uc.image} alt={uc.title} loading="lazy" />
              </div>
              <div className={styles.useCaseBody}>
                <span className={styles.useCaseCompany}>{uc.label}</span>
                <h3 className={styles.useCaseTitle}>{uc.title}</h3>
                <p className={styles.useCaseDesc}>{uc.description}</p>
                <span className={styles.useCaseLink}>{uc.external ? 'Read more ↗' : 'Start learning →'}</span>
              </div>
            </>
          );
          return uc.external ? (
            <a key={uc.title} href={uc.href} target="_blank" rel="noopener noreferrer" className={styles.useCaseCard}>
              {inner}
            </a>
          ) : (
            <Link key={uc.title} to={uc.href} className={styles.useCaseCard}>
              {inner}
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function AgentsSection() {
  return (
    <section className={styles.integrations}>
      <p className={styles.integrationsTitle}>
        Pre-built integrations for your platform stack, or bring your own MCP server and build custom agents
      </p>
      <div className={styles.integrationsList}>
        {AGENTS.map((a) => (
          <span key={a} className={styles.integrationChip}>{a}</span>
        ))}
      </div>
    </section>
  );
}

function QuickStartSection() {
  return (
    <section className={styles.quickstart}>
      <div className={styles.quickstartInner}>
        <div className={styles.sectionHeader} style={{textAlign: 'left', marginBottom: '1.5rem'}}>
          <p className={styles.sectionLabel}>Quick Install</p>
          <Heading as="h2" className={styles.sectionTitle}>
            Up and running in minutes
          </Heading>
          <p className={styles.sectionSubtitle} style={{margin: 0}}>
            Install with the setup script or Helm. Bring your own LLM, any
            OpenAI-compatible endpoint works.
          </p>
        </div>

        <div className={styles.codeBlock}>
          <div className={styles.codeHeader}>
            <span className={styles.codeTab}>curl · Kind cluster or existing K8s</span>
            <CopyButton text={CURL_CMD} />
          </div>
          <pre className={styles.codePre}>
            <code>
              <span className={styles.codeComment}># Install CAIPE via setup script</span>{'\n'}
              <span className={styles.codePrompt}>$</span>{' '}
              {'bash <(curl -fsSL https://raw.githubusercontent.com/caipe-io/ai-platform-engineering/main/setup-caipe.sh)'}
            </code>
          </pre>
        </div>

        <div className={styles.codeBlock}>
          <div className={styles.codeHeader}>
            <span className={styles.codeTab}>Kubernetes · Helm</span>
            <CopyButton text={HELM_CMD} />
          </div>
          <pre className={styles.codePre}>
            <code>
              <span className={styles.codeComment}># Or via Helm</span>{'\n'}
              <span className={styles.codePrompt}>$</span>{' '}
              {'helm upgrade --install ai-platform-engineering \\'}{'\n'}
              {'    oci://ghcr.io/caipe-io/charts/ai-platform-engineering \\'}{'\n'}
              {'    --version 1.0.1 -f your-values.yaml'}
            </code>
          </pre>
        </div>

        <div style={{marginTop: '1.5rem', display: 'flex', gap: '1rem', flexWrap: 'wrap'}}>
          <Link className={styles.heroPrimary} to="/docs/installation">
            Full Install Guide →
          </Link>
          <Link className={styles.heroSecondaryDark} to="/docs/getting-started/quick-start">
            Quick Start
          </Link>
        </div>
      </div>
    </section>
  );
}

function VisionSection() {
  return (
    <section className={styles.vision}>
      <div className={styles.visionInner}>
        <Heading as="h2" className={styles.visionTitle}>Our Mission</Heading>
        <p className={styles.visionBody}>
          To make AI automation something{' '}
          <strong className={styles.visionHighlight}>
            any team can run and trust
          </strong>
          . Open source, self-hosted, and secure from day one.
        </p>
      </div>
    </section>
  );
}


function VideoSection() {
  return (
    <section className={styles.quickstart}>
      <div className={styles.quickstartInner}>
        <div className={styles.sectionHeader} style={{textAlign: 'left', marginBottom: '1.5rem'}}>
          <p className={styles.sectionLabel}>See It In Action</p>
          <Heading as="h2" className={styles.sectionTitle}>
            Watch the demo
          </Heading>
        </div>
        <div style={{position: 'relative', paddingBottom: '56.25%', height: 0, overflow: 'hidden', borderRadius: '12px'}}>
          <iframe
            src="https://app.vidcast.io/share/embed/e0033e26-46bf-4298-8c20-0a2fd1746073"
            style={{position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', border: 0}}
            allowFullScreen
            title="CAIPE Demo"
          />
        </div>
      </div>
    </section>
  );
}

function CtaSection() {
  return (
    <section className={styles.cta}>
      <div className={styles.ctaButtons}>
        <Link className={styles.heroPrimary} to="/community">
          Get Involved
        </Link>
        <Link
          className={styles.heroSecondary}
          href="https://github.com/caipe-io/ai-platform-engineering"
        >
          Star on GitHub ↗
        </Link>
      </div>
    </section>
  );
}

export default function Home() {
  const {siteConfig} = useDocusaurusContext();
  return (
    <Layout
      title={siteConfig.title}
      description="Open Source AI Platform for All. Build, govern, and operate secure AI agents and agentic workflows for enterprises and individuals."
    >
      <main>
        <HeroSection />
        <VideoSection />
        <InTheWildSection />
        <VisionSection />
        <FeaturesSection />
        <AgentsSection />
        <CtaSection />
      </main>
    </Layout>
  );
}
