---
sidebar_position: 1
---

# Run CAIPE with KinD (Kubernetes in Docker)

This guide gets you from zero to a running **CAIPE** (Community AI Platform Engineering) environment on your laptop using **KinD** (Kubernetes in Docker). No prior experience with CAIPE or Kubernetes is required.

**What is CAIPE?** CAIPE is an open source platform for building and running **AI agents** that can use tools, talk to LLMs (like Claude or GPT), and work together in multi-agent systems. This setup gives you a local environment where you can try agents, add RAG (retrieval-augmented generation), and observe traces—all on your machine.

---

## Quickstart

No clone required. Run this in your terminal and follow the prompts:

```bash
curl -fsSL https://raw.githubusercontent.com/caipe-io/ai-platform-engineering/main/setup-caipe.sh | bash
```

The interactive script will ask for your LLM provider, API key, and optional components (RAG, tracing, persistence). That's it.

> **Want to inspect the script first?** View it at [`setup-caipe.sh`](https://github.com/caipe-io/ai-platform-engineering/blob/main/setup-caipe.sh) before running.

<iframe src="https://asciinema.org/a/845278/iframe" width="100%" height="600" style={{border: 'none', borderRadius: '8px', overflow: 'hidden'}} scrolling="no" allowFullScreen />

> [View full screen recording on asciinema](https://asciinema.org/a/845278)

---

## Step 1: Prerequisites

Before running the setup script, install these tools if you don’t have them yet:

| Tool | Purpose |
|------|---------|
| **Docker** | Runs containers (Docker Desktop or compatible runtime) |
| **Kind** | Runs a small Kubernetes cluster inside Docker |
| **kubectl** | Command-line client for Kubernetes |
| **Helm** | Installs CAIPE and its components on the cluster |
| **Python 3** | Used by the setup script |
| **curl** | Used for health checks |

The script will check for these at startup and can create a Kind cluster for you if one doesn’t exist.

---

## Step 3: Run the setup script

From the **repository root** (the `ai-platform-engineering` folder you cloned), run:

```bash
./setup-caipe.sh
```

The script is **interactive** and will:

1. **Select or create a Kubernetes cluster** — If you don’t have one, it can create a Kind cluster named `caipe`.
2. **Choose an LLM provider** — **Anthropic Claude** is the recommended default; OpenAI and AWS Bedrock are also supported.
3. **Ask for your API key** — You’ll enter the key when prompted (or the script can read it from a config file; see below).
4. **Optionally enable RAG and tracing** — You can add a RAG stack and Langfuse tracing when asked.

When it finishes, you’ll have CAIPE running locally. The script will tell you how to open the UI and run your first queries.

### Tear down when you’re done

To remove the environment and free resources:

```bash
./setup-caipe.sh cleanup
```

---

## Quick reference

### What the script does

- Deploys CAIPE (UI, Dynamic Agents, MCP servers) on your Kind cluster
- Configures your chosen LLM provider and stores credentials in Kubernetes secrets
- Optionally deploys RAG (knowledge base) and Langfuse (tracing)
- Can create the Kind cluster for you and run health checks

### Useful commands

| Command | Description |
|---------|-------------|
| `./setup-caipe.sh` | Full interactive setup (default) |
| `./setup-caipe.sh port-forward` | Start port-forwarding and run validation |
| `./setup-caipe.sh validate` | Run validation and sanity tests only |
| `./setup-caipe.sh cleanup` | Interactive teardown of all resources |
| `./setup-caipe.sh nuke` | Non-interactive teardown |
| `./setup-caipe.sh status` | Show pod status and Helm releases |

### Non-interactive mode (CI or scripts)

For automation, use `--non-interactive` and environment variables:

```bash
# Create cluster and deploy with Claude (default)
./setup-caipe.sh --non-interactive --create-cluster

# Full stack: RAG + Langfuse tracing + auto-heal
./setup-caipe.sh --non-interactive --create-cluster --rag --tracing --auto-heal

# Non-interactive teardown
./setup-caipe.sh nuke
```

Credentials are read from `~/.config/claude.txt` and `~/.config/openai.txt` when set. You can override with `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.

### Options

| Flag | Description |
|------|-------------|
| `--non-interactive` | Skip prompts; use env vars or defaults |
| `--create-cluster` | Create a Kind cluster if none exists (name: `caipe`) |
| `--rag` | Deploy the RAG stack (knowledge base, embeddings) |
| `--graph-rag` | Deploy Graph RAG (Neo4j + ontology agent; implies `--rag`) |
| `--tracing` | Deploy Langfuse and enable tracing |
| `--no-shared-postgres` | Skip the shared Postgres; use Keycloak embedded H2 + OpenFGA in-memory (ephemeral — RBAC state is lost on every pod restart). Persistent Postgres is the default for RBAC installs. |
| `--litellm` | Route chat (and OpenAI/Azure embeddings) through an in-cluster LiteLLM proxy so agents use one OpenAI-compatible endpoint and upstream provider keys stay in the proxy. Supports anthropic/openai/aws-bedrock/azure-openai. |
| `--litellm-db` | Like `--litellm`, plus persist LiteLLM virtual keys/spend in the shared Postgres |
| `--ingest-url=URL` | Ingest a URL into the RAG knowledge base (implies `--rag`; repeatable) |
| `--auto-heal` | Enable auto-heal loop (every 30s) |
| `--yes`, `-y` | Auto-confirm cleanup prompts |
| `-h`, `--help` | Show help |

---

## LLM providers

### Anthropic Claude (default, recommended)

Run the script and follow the prompts. When asked for a provider, choose **Anthropic Claude** (or accept the default).

To avoid typing your key every time, put it in a file (one line, no extra spaces):

```bash
# Create the file and add your key (replace with your real key)
echo "sk-ant-your-key-here" > ~/.config/claude.txt
chmod 600 ~/.config/claude.txt
```

The script looks for your key in this order: `ANTHROPIC_API_KEY` env var → `~/.config/claude.txt` → interactive prompt.

**Non-interactive:**

```bash
ANTHROPIC_API_KEY=sk-ant-xxx ./setup-caipe.sh --non-interactive --create-cluster
```

### OpenAI

Choose **OpenAI** when the script asks for a provider, or set:

```bash
LLM_PROVIDER=openai ./setup-caipe.sh
```

Store your key in `~/.config/openai.txt` (one line) to skip the prompt.

**Non-interactive:**

```bash
LLM_PROVIDER=openai OPENAI_API_KEY=sk-xxx ./setup-caipe.sh --non-interactive --create-cluster
```

### AWS Bedrock

Choose **AWS Bedrock** when prompted, or:

```bash
LLM_PROVIDER=aws-bedrock ./setup-caipe.sh
```

The script uses your AWS credentials (env vars, `~/.config/bedrock.txt`, or `~/.aws/credentials`).

**Non-interactive:**

```bash
LLM_PROVIDER=aws-bedrock AWS_PROFILE=my-profile ./setup-caipe.sh --non-interactive --create-cluster
```

---

## Enabling RAG (knowledge base)

When you run the script interactively, it can enable **RAG** (retrieval-augmented generation)—a knowledge base that agents can query. You can also pass the flag:

```bash
./setup-caipe.sh --rag
```

RAG uses **OpenAI embeddings** by default. If your main LLM is Claude, the script will ask for both your Anthropic key (for the LLM) and an OpenAI key (for embeddings). It can read the OpenAI key from `~/.config/openai.txt` or `OPENAI_API_KEY`.

### Ingesting documentation

After RAG is deployed, you can ingest a documentation site:

```bash
./setup-caipe.sh --non-interactive --rag --ingest-url=https://caipe.io/
```

You can monitor progress in the CAIPE UI under the Knowledge Base tab.

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_PROVIDER` | `anthropic-claude` | `anthropic-claude`, `aws-bedrock`, or `openai` |
| `OPENAI_API_KEY` | — | OpenAI API key (also used for RAG embeddings when RAG is enabled) |
| `ANTHROPIC_API_KEY` | — | Anthropic API key |
| `KIND_CLUSTER_NAME` | `caipe` | Kind cluster name (used with `--create-cluster`) |
| `CAIPE_CHART_VERSION` | latest | Pin Helm chart version |

---

## Ports

| Service | Local port |
|---------|------------|
| Dynamic Agents API | 8001 |
| CAIPE UI | 3000 |
| Langfuse (tracing) | 3100 |
| RAG Server | 9446 |

---

## Next steps

- [Configure LLM providers for KinD](./configure-llms) — More detail on keys and providers
- [Configure agent secrets for KinD](./configure-agent-secrets) — Agent-specific secrets
