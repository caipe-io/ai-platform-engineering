import React from 'react';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import styles from './community.module.css';

const CHANNELS = [
  {
    icon: '💬',
    title: 'CNCF Slack',
    description: 'Chat with the community in real time.',
    cta: 'Join the CAIPE community channel',
    href: 'https://cloud-native.slack.com/archives/C08N0AKR52S',
    note: 'Need a CNCF Slack invite?',
    noteHref: 'https://communityinviter.com/apps/cloud-native/cncf',
  },
  {
    icon: '📅',
    title: 'Weekly Community Meeting',
    description: 'Every Monday · 12:00–13:00 CST / 10:00–11:00 PST / 19:00–20:00 CET.',
    cta: 'Join via Webex',
    href: 'https://go.webex.com/meet/cnoe',
    note: 'View calendar',
    noteHref:
      'https://calendar.google.com/calendar/u/0/embed?src=064a2adfce866ccb02e61663a09f99147f22f06374e7a8994066bdc81e066986@group.calendar.google.com&ctz=America/Los_Angeles',
  },
  {
    icon: '🎥',
    title: 'Meeting Recordings',
    description: 'Catch up on past community meetings and demos.',
    cta: 'Watch recordings',
    href: 'https://www.youtube.com/@caipe-io',
    note: null,
    noteHref: null,
  },
  {
    icon: '🐙',
    title: 'GitHub Discussions',
    description: 'Ask questions, share ideas, and discuss platform engineering use cases.',
    cta: 'Open a discussion',
    href: 'https://github.com/caipe-io/ai-platform-engineering/discussions',
    note: null,
    noteHref: null,
  },
  {
    icon: '🗺️',
    title: 'Roadmap',
    description: 'See what the team is working on and upvote issues.',
    cta: 'View roadmap',
    href: 'https://github.com/orgs/cnoe-io/projects/9',
    note: null,
    noteHref: null,
  },
  {
    icon: '🏛️',
    title: 'Governance',
    description: 'CAIPE project charter, roles, and decision-making process.',
    cta: 'Read governance docs',
    href: 'https://github.com/caipe-io/governance',
    note: null,
    noteHref: null,
  },
];

const CONTRIBUTE = [
  {
    icon: '🌱',
    title: 'Pick a Good First Issue',
    description: 'New to the project? Browse issues tagged for first-time contributors — bite-sized and well-scoped.',
    href: 'https://github.com/caipe-io/ai-platform-engineering/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22good%20first%20issue%22',
  },
  {
    icon: '🛠️',
    title: 'Build an Agent',
    description: 'Add a new platform agent — pick a tool you use and follow the agent template.',
    href: '/docs/development/creating-an-agent',
  },
  {
    icon: '📝',
    title: 'Write a Skill',
    description: 'Skills are plain Markdown files that give coding agents a repeatable playbook. Author one for your team\'s runbooks.',
    href: '/docs/repo-ops/skills/create-skill',
  },
  {
    icon: '🐛',
    title: 'File Issues',
    description: 'Found a bug or have a feature request? Open a GitHub issue.',
    href: 'https://github.com/caipe-io/ai-platform-engineering/issues',
  },
  {
    icon: '📖',
    title: 'Improve Docs',
    description: 'Every doc page has an "Edit this page" link. Typo fixes welcome.',
    href: '/docs/contributing',
  },
];

export default function CommunityPage() {
  return (
    <Layout
      title="Community · CAIPE"
      description="Join the CAIPE community — weekly meetings, CNCF Slack, GitHub Discussions, and more."
    >
      <main>
        {/* Hero */}
        <section className={styles.hero}>
          <div className={styles.heroInner}>
            <Heading as="h1" className={styles.heroTitle}>
              Join the CAIPE Community
            </Heading>
            <p className={styles.heroSubtitle}>
              CAIPE is built by and for platform engineers. Connect with the
              community, share your deployments, contribute agents, and help
              shape the roadmap.
            </p>
            <div className={styles.heroButtons}>
              <Link
                className={styles.primaryBtn}
                href="https://communityinviter.com/apps/cloud-native/cncf"
              >
                Join CNCF Slack →
              </Link>
              <Link
                className={styles.secondaryBtn}
                href="https://github.com/caipe-io/ai-platform-engineering"
              >
                GitHub ↗
              </Link>
            </div>
          </div>
        </section>

        {/* Connect channels */}
        <section className={styles.section}>
          <div className={styles.sectionInner}>
            <Heading as="h2" className={styles.sectionTitle}>
              Ways to connect
            </Heading>
            <div className={styles.channelGrid}>
              {CHANNELS.map((ch) => (
                <div key={ch.title} className={styles.channelCard}>
                  <span className={styles.channelIcon}>{ch.icon}</span>
                  <Heading as="h3" className={styles.channelTitle}>{ch.title}</Heading>
                  <p className={styles.channelDesc}>{ch.description}</p>
                  <Link className={styles.channelCta} href={ch.href}>
                    {ch.cta} ↗
                  </Link>
                  {ch.note && ch.noteHref && (
                    <p className={styles.channelNote}>
                      <Link href={ch.noteHref}>{ch.note}</Link>
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Contribute */}
        <section className={`${styles.section} ${styles.sectionAlt}`}>
          <div className={styles.sectionInner}>
            <Heading as="h2" className={styles.sectionTitle}>
              Contribute
            </Heading>
            <p className={styles.sectionSubtitle}>
              All contributions welcome — from first-time contributors to
              experienced platform engineers.
            </p>
            <div className={styles.contributeGrid}>
              {CONTRIBUTE.map((c) => (
                <Link key={c.title} className={styles.contributeCard} to={c.href}>
                  <span className={styles.contributeIcon}>{c.icon}</span>
                  <Heading as="h3" className={styles.contributeTitle}>{c.title}</Heading>
                  <p className={styles.contributeDesc}>{c.description}</p>
                </Link>
              ))}
            </div>
          </div>
        </section>
      </main>
    </Layout>
  );
}
