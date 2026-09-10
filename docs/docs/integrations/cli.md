---
sidebar_position: 4
---

# CAIPE CLI

:::caution Refactor in Progress
The CLI is under active development. Track progress in [PR #1184](https://github.com/caipe-io/ai-platform-engineering/pull/1184). Commands, flags, and installation paths may change before the final merge.
:::


AI-assisted coding, workflows, and platform engineering from the terminal.

CAIPE CLI is a TypeScript/Bun CLI that connects to a CAIPE server via the A2A or AG-UI streaming protocol. It provides an interactive chat REPL, headless mode for CI/CD pipelines, skill management, and secure credential storage.

## Installation

### Quick install (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/caipe-io/ai-platform-engineering/main/cli/install.sh | sh
```

Installs the correct binary for your platform (macOS/Linux, arm64/x64) to `/usr/local/bin/caipe`.

**Options:**
- `CAIPE_INSTALL_DIR` — override install directory (default: `/usr/local/bin`)
- `CAIPE_VERSION` — pin a specific version (default: latest)

### npm

```bash
npm install -g caipe
```

### Build from source

```bash
git clone https://github.com/caipe-io/ai-platform-engineering.git
cd ai-platform-engineering/cli
bun install
npm run compile   # produces dist/caipe (Bun single-file binary)
./dist/caipe --version
```

## Quick Start

```bash
# 1. Point to your CAIPE server
caipe config set server.url https://your-caipe-server.example.com

# 2. Authenticate (opens browser for OAuth)
caipe auth login

# 3. Start chatting
caipe
```

## Commands

| Command | Description |
|---------|-------------|
| `caipe` | Open interactive chat REPL |
| `caipe chat` | Open chat (explicit). Options: `--agent`, `--protocol`, `--headless`, `--resume` |
| `caipe auth login` | Authenticate via OAuth (browser or `--device` flow) |
| `caipe auth logout` | Remove stored credentials |
| `caipe auth status` | Print current auth state |
| `caipe config set <key> <value>` | Set a configuration key |
| `caipe config get <key>` | Print the current value of a key |
| `caipe config unset <key>` | Remove a configuration key |
| `caipe skills list` | List available skills from catalog |
| `caipe skills install <name>` | Install a skill |
| `caipe skills preview <name>` | Display full SKILL.md content |
| `caipe skills update [name]` | Check and update installed skills |
| `caipe agents list` | List available server agents |
| `caipe agents info <name>` | Show agent capabilities |
| `caipe memory` | Manage persistent context files |
| `caipe commit` | DCO-compliant commit with AI attribution |

### Global Options

```
--agent <name>    CAIPE server agent to use (default: "default")
--url <url>       Override server.url from settings.json
--no-color        Disable ANSI color output
--json            Machine-readable JSON output
-v, --version     Print version and exit
```

## Interactive Chat

The chat REPL provides:

- **Streaming responses** via A2A or AG-UI Server-Sent Events
- **Slash commands** — type `/` for a picker: `/clear`, `/compact`, `/login`, `/skills`, `/agents`, `/help`, `/exit`
- **Readline keybindings** — `Ctrl+A/E`, `Ctrl+B/F`, `Alt+B/F`, `Ctrl+U/K/W`, `Ctrl+D`
- **Input history** — `Up/Down` or `Ctrl+P/N`
- **Shell pipes** — `!command` runs a shell command and injects output
- **Tool call visualization** — active tool calls shown in the status footer

## Headless Mode

For CI/CD pipelines and scripting:

```bash
# Single prompt
caipe chat --headless --prompt "Explain the deployment architecture"

# From file
caipe chat --headless --prompt-file question.txt --output json

# Multi-turn via stdin
echo -e "Hello\nWhat is A2A?" | caipe chat --headless --interactive-stdin

# With explicit token
caipe chat --headless --token "$JWT" --prompt "status check"
```

## Configuration

Settings are stored in `~/.config/caipe/settings.json`.

| Key | Description | Example |
|-----|-------------|---------|
| `server.url` | CAIPE server base URL | `https://caipe.example.com` |
| `auth.url` | OAuth authorization endpoint (auto-discovered if not set) | `https://auth.example.com` |
| `auth.apiKey` | Static API key (alternative to OAuth) | `sk-...` |
| `auth.credential-storage` | Credential backend: `encrypted-file` or `keychain` | `encrypted-file` |

## Source

[`cli/` directory in ai-platform-engineering](https://github.com/caipe-io/ai-platform-engineering/tree/main/cli)
