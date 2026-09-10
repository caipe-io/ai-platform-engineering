# Development Guide

Welcome to the CAIPE development documentation! This section provides comprehensive guides for developers who want to contribute to the project or build their own agents and MCP servers.

## 📚 What You'll Learn

This development guide covers:

- **[Spec-Driven Development](./spec-driven-development)** - How CAIPE uses spec-kit for agentic software development
- **[Development Environment Setup](./development-environment)** - Configure your local development environment
- **[Creating an Agent](./creating-an-agent)** - Build a new AI agent from scratch
- **[Creating an MCP Server](./creating-mcp-server)** - Develop a Model Context Protocol server
- **[CI/CD and Releases](./ci-cd-and-releases)** - Understand PR version bumps, prebuild artifacts, RC tags, hotfixes, and final releases

## 🎯 Who Is This For?

These guides are designed for:

- **Contributors** wanting to add new features or fix bugs
- **Developers** building custom agents for their organization
- **Platform Engineers** extending the platform with new capabilities
- **Students** learning about AI agents and MCP

## 🛠️ Prerequisites

Before you begin, you should have:

- Basic knowledge of Python 3.11+
- Familiarity with async/await patterns
- Understanding of REST APIs
- Git and Docker installed
- An LLM API key (OpenAI, Anthropic, or Azure OpenAI)

## 🚀 Quick Start Path

1. **[Understand spec-driven development](./spec-driven-development)** - How CAIPE uses spec-kit for feature development
2. **[Set up your development environment](./development-environment)** - Install dependencies and configure your workspace
3. **[Explore the template agent](./creating-an-agent#understanding-the-template)** - Understand the project structure
4. **[Build your first agent](./creating-an-agent#step-1-clone-the-template)** - Follow the step-by-step guide
5. **[Add an MCP server](./creating-mcp-server)** - Connect your agent to external APIs

## 📖 Additional Resources

- [Contributing Guide](../contributing/index.md) - Contribution workflow and standards
- [Architecture Overview](../architecture/index.md) - System design and components
- [Agents & MCP Servers](../agents/README.md) - Existing implementations
- [Security Best Practices](../security/index.md) - Security guidelines

## 💡 Development Philosophy

CAIPE follows these principles:

- **Convention over Configuration** - Sensible defaults with flexibility
- **Security by Default** - Built-in authentication and authorization
- **Observable & Traceable** - OpenTelemetry integration out of the box
- **Test-Driven** - Comprehensive testing with evaluations
- **Production-Ready** - Docker, Kubernetes, and CI/CD support

## 🏅 Contribution Badges

CAIPE recognizes your journey with four badge levels — from running your first multi-agent setup to deploying at production scale and mentoring others.

| Badge | Level | How to Earn |
|-------|-------|-------------|
| 🧑‍🚀 **Explorer** | 1 | Run the multi-agent system with at least one use case |
| 🔧 **Improver** | 2 | Customize agents, add RAG, integrate tracing and evaluations |
| 🧠 **Expert** | 3 | Zero-trust deployment, agent gateways, OSS contributions |
| 🥋 **Master** | 4 | Production-scale deployment, mentorship, pioneering new patterns |

See the full badge guide and how to claim yours → [Contributing & Badges](../contributing/index.md#-contribution-badges)

## 🤝 Getting Help

- **Issues**: [GitHub Issues](https://github.com/caipe-io/ai-platform-engineering/issues)
- **Discussions**: [GitHub Discussions](https://github.com/caipe-io/ai-platform-engineering/discussions)
- **Community**: [CAIPE community meetings](../community/index.md)
- **Slack**: [Join the CAIPE community channel on CNCF Slack](https://cloud-native.slack.com/archives/C08N0AKR52S)

Let's build something amazing together! 🚀
