---
sidebar_position: 2
sidebar_label: Specification
title: "2026-02-10: GitHub App Authentication for the GitHub Agent"
---

# GitHub App Authentication for the GitHub Agent

**Date**: 2026-02-10
**Author**: Sri Aradhyula (sraradhy@cisco.com)
**Status**: Implemented
**Branch**: `prebuild/github-app-token-auto-refresh`

---

## Overview

The GitHub agent now supports **GitHub App authentication** as an alternative to Personal Access Tokens (PATs). GitHub App tokens are short-lived (60 minutes) and auto-refresh, eliminating the need for monthly PAT rotation.


## Prerequisites

- GitHub organization **admin access** (to create and install apps)
- Access to a secrets manager for storing the private key (production)

---


## Related

- [Token provider implementation](https://github.com/caipe-io/ai-platform-engineering/blob/main/ai_platform_engineering/utils/github_app_token_provider.py)
- [GitHub App authentication docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app)
- [GitHub MCP Server - App auth issues](https://github.com/github/github-mcp-server/issues/311)
- [Installation token API](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)


- Architecture: [architecture.md](./architecture.md)
