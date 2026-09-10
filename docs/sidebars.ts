import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

/**
 * Creating a sidebar enables you to:
 - create an ordered group of docs
 - render a sidebar for each doc of that group
 - provide next/previous navigation

 The sidebars can be generated from the filesystem, or explicitly defined here.

 Create as many sidebars as you want.
 */
const sidebars: SidebarsConfig = {
  // By default, Docusaurus generates a sidebar from the docs folder structure
  docsSidebar: [
    {
      type: 'category',
      label: 'Getting Started',
      items: [
        {
          type: 'doc',
          id: 'getting-started/quick-start',
        },
      ],
    },
    {
      type: 'category',
      label: 'Setup',
      items: [
        {
          type: 'category',
          label: 'Docker',
          items: [
            {
              type: 'doc',
              id: 'getting-started/docker-compose/setup',
            },
            {
              type: 'doc',
              id: 'getting-started/docker-compose/configure-llms',
            },
            {
              type: 'doc',
              id: 'getting-started/docker-compose/configure-agent-secrets',
            },
          ],
        },
        {
          type: 'category',
          label: 'KinD',
          items: [
            {
              type: 'doc',
              id: 'getting-started/kind/setup',
            },
            {
              type: 'doc',
              id: 'getting-started/kind/configure-llms',
            },
            {
              type: 'doc',
              id: 'getting-started/kind/configure-agent-secrets',
            },
          ],
        },
        {
          type: 'category',
          label: 'Helm',
          items: [
            {
              type: 'doc',
              id: 'getting-started/helm/cluster-setup',
              label: 'Cluster Setup',
            },
            {
              type: 'doc',
              id: 'getting-started/helm/setup',
            },
            {
              type: 'category',
              label: 'Chart Reference',
              items: [
                {
                  type: 'category',
                  label: 'ai-platform-engineering',
                  items: [
                    {
                      type: 'doc',
                      id: 'installation/helm-charts/ai-platform-engineering/ai-platform-engineering-chart',
                      label: 'Overview (parent chart)',
                    },
                    {
                      type: 'doc',
                      id: 'installation/helm-charts/ai-platform-engineering/mcp-server-chart',
                      label: 'mcp-server',
                    },
                    {
                      type: 'doc',
                      id: 'installation/helm-charts/ai-platform-engineering/caipe-ui-chart',
                      label: 'caipe-ui',
                    },
                    {
                      type: 'doc',
                      id: 'installation/helm-charts/ai-platform-engineering/caipe-ui-mongodb-chart',
                      label: 'caipe-ui-mongodb',
                    },
                    {
                      type: 'doc',
                      id: 'installation/helm-charts/ai-platform-engineering/dynamic-agents-chart',
                      label: 'dynamic-agents',
                    },
                    {
                      type: 'doc',
                      id: 'installation/helm-charts/ai-platform-engineering/autonomous-agents-chart',
                      label: 'autonomous-agents',
                    },
                    {
                      type: 'doc',
                      id: 'installation/helm-charts/ai-platform-engineering/slack-bot-chart',
                      label: 'slack-bot',
                    },
                  ],
                },
                {
                  type: 'category',
                  label: 'rag-stack',
                  items: [
                    {
                      type: 'doc',
                      id: 'installation/helm-charts/rag-stack/rag-stack-chart',
                      label: 'Overview (parent chart)',
                    },
                    {
                      type: 'doc',
                      id: 'installation/helm-charts/rag-stack/rag-server-chart',
                      label: 'rag-server',
                    },
                    {
                      type: 'doc',
                      id: 'installation/helm-charts/rag-stack/rag-redis-chart',
                      label: 'rag-redis',
                    },
                    {
                      type: 'doc',
                      id: 'installation/helm-charts/rag-stack/rag-ingestors-chart',
                      label: 'rag-ingestors',
                    },
                    {
                      type: 'doc',
                      id: 'installation/helm-charts/rag-stack/agent-ontology-chart',
                      label: 'agent-ontology',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      type: 'category',
      label: 'Development',
      items: [
        {
          type: 'doc',
          id: 'development/index',
          label: 'Overview',
        },
        {
          type: 'doc',
          id: 'development/development-environment',
          label: 'Development Environment',
        },
        {
          type: 'doc',
          id: 'development/creating-an-agent',
          label: 'Creating an Agent',
        },
        {
          type: 'doc',
          id: 'development/creating-mcp-server',
          label: 'Creating an MCP Server',
        },
        {
          type: 'doc',
          id: 'development/spec-driven-development',
          label: 'Spec-Driven Development',
        },
        {
          type: 'doc',
          id: 'development/ci-cd-and-releases',
          label: 'CI/CD & Releases',
        },
        {
          type: 'doc',
          id: 'development/prebuild-flow',
          label: 'Prebuild Flow',
        },
        { type: 'doc', id: 'repo-ops/ci', label: 'CI Workflows' },
        { type: 'doc', id: 'repo-ops/releases', label: 'How to Cut a Release' },
        { type: 'doc', id: 'repo-ops/issue-triage', label: 'Issue Triage Dashboard' },
        {
          type: 'category',
          label: 'Advanced',
          items: [
            {
              type: 'doc',
              id: 'development/advanced/ci-infrastructure',
              label: 'CI Infrastructure',
            },
          ],
        },
        {
          type: 'category',
          label: 'Skills',
          items: [
            { type: 'doc', id: 'repo-ops/skills/index', label: 'Overview' },
            { type: 'doc', id: 'repo-ops/skills/create-skill', label: 'Create a Skill' },
          ],
        },
      ],
    },
    {
      type: 'category',
      label: 'Architecture',
      link: {
        type: 'generated-index',
        description:
          'Solution architecture, gateway, identity federation, Slack authorization, scheduler, and streaming.',
      },
      items: [
        { type: 'doc', id: 'architecture/index', label: 'Solution Architecture' },
        { type: 'doc', id: 'architecture/gateway', label: 'AgentGateway' },
        { type: 'doc', id: 'architecture/scheduler', label: 'Scheduler' },
        { type: 'doc', id: 'architecture/autonomous-agents', label: 'Autonomous Agents' },
        {
          type: 'doc',
          id: 'architecture/enterprise-identity-federation',
          label: 'Enterprise Identity Federation',
        },
        { type: 'doc', id: 'architecture/slack-bot-authorization', label: 'Slack Bot Authorization' },
        { type: 'doc', id: 'architecture/slack-io-guardrails', label: 'Slack I/O Guardrails' },
        { type: 'doc', id: 'architecture/streaming_architecture', label: 'Streaming Architecture' },
      ],
    },
    {
      type: 'category',
      label: 'Features',
      items: [
        { type: 'doc', id: 'features/agent-builder', label: 'Agent Builder' },
        { type: 'doc', id: 'features/workflows', label: 'Workflows' },
        { type: 'doc', id: 'features/agentic-apps', label: 'External Apps' },
        {
          type: 'category',
          label: 'Rich Web UI',
          items: [
            { type: 'doc', id: 'ui/index', label: 'Overview' },
            { type: 'doc', id: 'ui/features', label: 'Features' },
            { type: 'doc', id: 'features/admin-settings', label: 'Admin Settings' },
            { type: 'doc', id: 'ui/configuration', label: 'Configuration' },
            { type: 'doc', id: 'ui/customization', label: 'Customization & Branding' },
            { type: 'doc', id: 'ui/development', label: 'Development Guide' },
            { type: 'doc', id: 'ui/selection-controls', label: 'Selection Controls' },
            { type: 'doc', id: 'ui/api-reference', label: 'API Reference' },
            { type: 'doc', id: 'ui/troubleshooting', label: 'Troubleshooting' },
          ],
        },
        {
          type: 'category',
          label: 'Knowledge Bases',
          items: [
            { type: 'doc', id: 'knowledge_bases/index', label: 'Overview' },
            // assisted-by Codex Codex-sonnet-4-6
            { type: 'doc', id: 'knowledge_bases/api-reference', label: 'API Reference' },
            { type: 'doc', id: 'knowledge_bases/architecture', label: 'Architecture' },
            { type: 'doc', id: 'knowledge_bases/ingestors', label: 'Ingestors' },
            { type: 'doc', id: 'knowledge_bases/ontology-agent', label: 'Ontology Agent' },
            { type: 'doc', id: 'knowledge_bases/mcp-tools', label: 'MCP Tools' },
            { type: 'doc', id: 'knowledge_bases/authentication-overview', label: 'Authentication' },
          ],
        },
        {
          type: 'category',
          label: 'Skills',
          items: [
            { type: 'doc', id: 'features/skills/README', label: 'Overview' },
          ],
        },
        {
          type: 'category',
          label: 'Integrations',
          items: [
            { type: 'doc', id: 'integrations/slack-bot', label: 'Slack Bot' },
            { type: 'doc', id: 'integrations/webex-bot', label: 'Webex Bot' },
            { type: 'doc', id: 'integrations/webex-meetings-mcp', label: 'Webex Meetings MCP' },
            { type: 'doc', id: 'api/webex-integration', label: 'Webex Bot RBAC API' },
            { type: 'doc', id: 'integrations/cli', label: 'CAIPE CLI' },
          ],
        },
        {
          type: 'category',
          label: 'Security',
          items: [
            { type: 'doc', id: 'security/index', label: 'Overview' },
            { type: 'doc', id: 'security/auth-flow', label: 'Authentication Flow' },
            { type: 'doc', id: 'security/agent-context-hmac', label: 'Agent Context HMAC' },
            {
              type: 'category',
              label: 'RBAC',
              link: { type: 'doc', id: 'security/rbac/index' },
              items: [
                { type: 'doc', id: 'security/rbac/feature-guide', label: 'Feature Guide' },
                { type: 'doc', id: 'security/rbac/architecture', label: 'Architecture' },
                { type: 'doc', id: 'security/rbac/pdp-coverage-audit', label: 'PDP Coverage Audit (BFF /api/*)' },
                { type: 'doc', id: 'security/rbac/comprehensive-rbac-refactor', label: 'Comprehensive Refactor' },
                { type: 'doc', id: 'security/rbac/workflows', label: 'Workflows' },
                { type: 'doc', id: 'security/rbac/usage', label: 'Usage' },
                { type: 'doc', id: 'security/rbac/roles-scopes-comparison', label: 'Roles vs Scopes' },
                { type: 'doc', id: 'security/rbac/helm-install-upgrade', label: 'Helm Install and Upgrade' },
                { type: 'doc', id: 'security/rbac/caipe-rbac-migration', label: 'CAIPE RBAC Migration' },
                { type: 'doc', id: 'security/rbac/audit-log-performance', label: 'Audit Log Performance' },
                { type: 'doc', id: 'security/rbac/secrets-bootstrap', label: 'Secrets Bootstrap' },
                { type: 'doc', id: 'security/rbac/agent-context-hmac', label: 'Agent Context HMAC' },
                { type: 'doc', id: 'security/rbac/file-map', label: 'File Map' },
              ],
            },
            { type: 'doc', id: 'security/supply-chain', label: 'Supply Chain Security' },
          ],
        },
        { type: 'doc', id: 'prompt-library/index', label: 'Prompt Library' },
        {
          type: 'category',
          label: 'Tracing & Evaluations',
          items: [
            { type: 'doc', id: 'evaluations/index', label: 'Overview' },
            // assisted-by Codex Codex-sonnet-4-6
            { type: 'doc', id: 'evaluations/ui-performance-benchmark-results', label: 'UI Performance Benchmarks' },
          ],
        },
        { type: 'doc', id: 'agent-ops/index', label: 'AgentOps' },
      ],
    },
    {
      type: 'category',
      label: 'MCP Servers',
      items: [
        {
          type: 'doc',
          id: 'agents/README',
          label: 'Overview',
        },
      ],
    },
    {
      type: 'category',
      label: 'Tools & Utilities',
      items: [
        {
          type: 'doc',
          id: 'tools-utils/openapi-mcp-codegen',
        },
        {
          type: 'doc',
          id: 'tools-utils/cnoe-agent-utils',
        },
        {
          type: 'doc',
          id: 'tools-utils/agent-chat-cli',
        },
        {
          type: 'doc',
          id: 'tools-utils/jira-mcp-implementations-comparison',
        }
      ],
    },
    {
      type: 'doc',
      id: 'contributing/index',
      label: 'Contributing',
    },
    {
      type: 'category',
      label: 'Specifications',
      items: [
        {
          type: 'autogenerated',
          dirName: 'specs',
        },
      ],
    },
  ],
  communitySidebar: [
    {
      type: 'category',
      label: 'Community',
      items: [
        {
          type: 'doc',
          id: 'community/index',
          label: 'Community Overview',
        },
        {
          type: 'doc',
          id: 'community/meeting-recordings',
          label: 'Meeting Recordings',
        },
      ],
    },
  ]
};

export default sidebars;
