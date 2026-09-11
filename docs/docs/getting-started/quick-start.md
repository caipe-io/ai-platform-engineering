---
sidebar_position: 2
---

# Quick Start

This is the fastest path from a fresh machine to a working CAIPE environment.
The setup script asks which LLM provider and optional services you want, then
starts the platform so you can open the UI and try an agent.

## One-command setup

No clone required. Run this in your terminal and follow the interactive prompts:

```bash
curl -fsSL https://raw.githubusercontent.com/caipe-io/ai-platform-engineering/main/setup-caipe.sh | bash
```

The script asks for your LLM provider, API key, and optional components (RAG,
tracing, persistence). It creates a local KinD cluster or deploys to an existing
one.

> **Want to inspect the script first?** View [`setup-caipe.sh`](https://github.com/caipe-io/ai-platform-engineering/blob/main/setup-caipe.sh) on GitHub before running.

<iframe src="https://asciinema.org/a/845278/iframe" width="100%" height="600" style={{border: 'none', borderRadius: '8px', overflow: 'hidden'}} scrolling="no" allowFullScreen />

> [View full screen recording on asciinema](https://asciinema.org/a/845278)

---

## Other setup options

| Guide | Best for |
|-------|----------|
| [**Docker Compose**](docker-compose/setup.md) | Local development or a single VM (EC2, etc.) |
| [**Helm**](helm/setup.md) | Any Kubernetes cluster — EKS, GKE, AKS, KinD, and more |

## After installation

1. Open the UI and sign in.
2. Start a chat with an available agent.
3. Open [Agent Builder](../features/agent-builder.md) to create or customize
   an agent.
4. Add [Knowledge Bases](../knowledge_bases/index.md) or an MCP server when the
   agent needs access to trusted data or tools.
