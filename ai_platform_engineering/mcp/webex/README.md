# Webex MCP Server Project

This project sets up a Webex MCP server using the MCP SDK and manages dependencies with uv.

## Prerequisites
- Python 3.14
- [uv](https://github.com/astral-sh/uv) (for dependency management)

## Setup

1. **Install uv** (if not already installed):
   ```sh
   pip install uv
   ```

2. **Install dependencies:**
   ```sh
   uv sync
   ```

3. **Run the server:**
   ```sh
   uv run mcp-server-webex
   ```
