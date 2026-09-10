---
sidebar_position: 4
---

# UI Customization & Branding

This guide covers all environment variables for customizing the CAIPE UI appearance, including branding, themes, fonts, gradients, and personalization defaults. These variables allow platform teams to white-label the UI without changing code.

## How It Works

All customization env vars are read at **runtime** (not build time) via `getServerConfig()`, serialized into `window.__APP_CONFIG__`, and injected by the root layout. This means you can change branding by simply restarting the container with new env vars — no rebuild required.

```
┌──────────────────────────────┐
│      Environment Variables   │
│  (runtime, per deployment)   │
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│   getServerConfig()          │
│   (reads process.env)        │
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│   window.__APP_CONFIG__      │
│   (injected into HTML)       │
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│   UI components read config  │
│   (getConfig('appName'))     │
└──────────────────────────────┘
```

All env vars also accept a `NEXT_PUBLIC_` prefix for backward compatibility (e.g., `NEXT_PUBLIC_APP_NAME`). The non-prefixed version takes priority when both are set.

## Branding

Control the application name, logo, tagline, and other branding elements.

| Variable | Default | Description |
|----------|---------|-------------|
| `APP_NAME` | `CAIPE` | Application name displayed in the header, browser tab, and throughout the UI |
| `TAGLINE` | `Multi-Agent Workflow Automation` | Main tagline shown on the login page and metadata |
| `DESCRIPTION` | `Where Humans and AI agents collaborate...` | Description text used in metadata and UI |
| `LOGO_URL` | `/logo.svg` | Logo image path (relative to `public/` or absolute URL) |
| `LOGO_STYLE` | `default` | Logo rendering: `default` (original colors) or `white` (inverted for dark backgrounds) |
| `FAVICON_URL` | `/favicon.ico` | Browser tab favicon (relative or absolute URL) |
| `SUPPORT_EMAIL` | `support@example.com` | Contact email shown in support/help links |
| `SHOW_POWERED_BY` | `true` | Show "Powered by OSS caipe.io" footer (`true` or `false`) |
| `PREVIEW_MODE` | `false` | Show preview/beta badge in the UI |

### Example: Custom Branding

```bash
APP_NAME=Grid
TAGLINE=Enterprise AI Platform
DESCRIPTION=Intelligent automation for platform engineering teams
LOGO_URL=/grid-logo.svg
LOGO_STYLE=white
FAVICON_URL=/grid-favicon.png
SUPPORT_EMAIL=support@grid.cisco.com
SHOW_POWERED_BY=false
```

## Gradient Colors

Control the primary gradient used throughout the UI (header accents, buttons, text highlights).

| Variable | Default | Description |
|----------|---------|-------------|
| `GRADIENT_FROM` | `hsl(173,80%,40%)` | Gradient start color (any valid CSS color) |
| `GRADIENT_TO` | `hsl(270,75%,60%)` | Gradient end color (any valid CSS color) |
| `SPINNER_COLOR` | *(theme default)* | Loading spinner/indicator color (any valid CSS color) |

These colors are injected as CSS custom properties (`--gradient-from`, `--gradient-to`, `--spinner-color`) and apply to all gradient utilities in the UI.

### Example: Corporate Blue Gradient

```bash
GRADIENT_FROM=#1a73e8
GRADIENT_TO=#174ea6
SPINNER_COLOR=#1a73e8
```

## UI Personalization Defaults

These variables set the **initial defaults** for users who have not customized
**Settings → Appearance**. Appearance changes save to the user's account and
also use a local browser cache so the interface can apply them immediately.

The precedence order is:

1. **Server preferences** (MongoDB, synced across devices) — highest priority
2. **localStorage** (per-browser cache)
3. **Environment variable defaults** (set by platform team)
4. **Built-in defaults** (hardcoded fallbacks) — lowest priority

### Font Size

| Variable | Default | Allowed Values | Description |
|----------|---------|----------------|-------------|
| `DEFAULT_FONT_SIZE` | `medium` | `small`, `medium`, `large`, `x-large` | Default base font size for new users |

Available sizes:

| Value | Pixel Size | Best For |
|-------|------------|----------|
| `small` | 14px | Dense information displays |
| `medium` | 16px | General use (browser default) |
| `large` | 18px | Improved readability |
| `x-large` | 20px | Accessibility, presentations |

### Font Family

| Variable | Default | Allowed Values | Description |
|----------|---------|----------------|-------------|
| `DEFAULT_FONT_FAMILY` | `inter` | `inter`, `source-sans`, `ibm-plex`, `system` | Default font family for new users |

Available font families:

| Value | Font | Description |
|-------|------|-------------|
| `inter` | Inter | Clean and modern (used by OpenAI) |
| `source-sans` | Source Sans 3 | Highly readable (by Adobe) |
| `ibm-plex` | IBM Plex Sans | Professional (IBM Carbon design system) |
| `system` | System UI | Native OS font (San Francisco, Segoe UI, etc.) |

### Theme

| Variable | Default | Allowed Values | Description |
|----------|---------|----------------|-------------|
| `DEFAULT_THEME` | `dark` | `system`, `light`, `legacy-light`, `dark`, `midnight`, `nord`, `tokyo`, `cyberpunk`, `tron`, `matrix` | Default color theme for new users. `legacy-light` preserves the original bright palette for comparison. |

Available themes:

| Value | Description |
|-------|-------------|
| `system` | Follow the operating system light or dark preference |
| `light` | Balanced tonal surfaces with restrained brand color |
| `legacy-light` | Original bright, near-white light palette for comparison |
| `dark` | Dark backgrounds, easy on the eyes |
| `midnight` | Pure black (optimized for OLED displays) |
| `nord` | Arctic cool tones (inspired by Nord color palette) |
| `tokyo` | Vibrant purple tones (inspired by Tokyo Night) |
| `cyberpunk` | Neon pink and cyan on deep purple-black, dystopian vibes |
| `tron` | Glowing electric cyan on near-black, digital frontier aesthetic |
| `matrix` | Green phosphor on black, digital rain aesthetic |

### Gradient Theme

| Variable | Default | Allowed Values | Description |
|----------|---------|----------------|-------------|
| `DEFAULT_GRADIENT_THEME` | `default` | `default`, `minimal`, `professional`, `ocean`, `sunset`, `cyberpunk`, `tron`, `matrix` | Default gradient style for new users |

Available gradient themes:

| Value | Colors | Description |
|-------|--------|-------------|
| `default` | Teal → Purple | Original vibrant gradient |
| `minimal` | Gray → Dark Gray | Subtle, understated |
| `professional` | Blue → Navy | Corporate, trustworthy |
| `ocean` | Cyan → Blue | Cool, calming |
| `sunset` | Orange → Pink | Warm, energetic |
| `cyberpunk` | Pink → Cyan | Neon-soaked, high-contrast |
| `tron` | Cyan → Blue | Electric glow, digital frontier |
| `matrix` | Green → Dark Green | Phosphor glow, digital rain |

:::info
The gradient selected in **Settings → Appearance** overrides both
`DEFAULT_GRADIENT_THEME` and the `GRADIENT_FROM`/`GRADIENT_TO` environment
variables. Environment-level gradient colors apply only when no user gradient
is active.
:::

### Example: Professional Defaults

```bash
DEFAULT_FONT_SIZE=medium
DEFAULT_FONT_FAMILY=ibm-plex
DEFAULT_THEME=light
DEFAULT_GRADIENT_THEME=professional
```

### Example: Accessibility-Focused Defaults

```bash
DEFAULT_FONT_SIZE=large
DEFAULT_FONT_FAMILY=source-sans
DEFAULT_THEME=light
DEFAULT_GRADIENT_THEME=minimal
```

## Header Links

Control which links appear in the application header.

| Variable | Default | Description |
|----------|---------|-------------|
| `DOCS_URL` | *(hidden)* | Documentation URL shown in the header. If not set, the docs link is hidden |
| `SOURCE_URL` | *(hidden)* | Source code / repository URL shown in the header. If not set, the link is hidden |

### Example: Header Links

```bash
DOCS_URL=https://docs.caipe.example.com
SOURCE_URL=https://github.com/caipe-io/ai-platform-engineering
```

## Login Page Customization

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLED_INTEGRATION_ICONS` | *(all icons)* | Comma-separated list of integration icons to show on the login page orbit. If not set, all icons are displayed |

Available icons: `argocd`, `aws`, `github`, `gitlab`, `jira`, `splunk`, `confluence`, `webex`, `kubernetes`, `slack`, `backstage`, `command line`, `workflows`, `pagerduty`, `linux`

### Example: Show Only Relevant Integrations

```bash
ENABLED_INTEGRATION_ICONS=github,slack,aws,kubernetes,jira
```

## Feature Flags

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKFLOW_RUNNER_ENABLED` | `false` | Enable the dedicated workflow runner UI. When `false`, the "Run Workflow" button and Multi-Step Workflows card are hidden; "Run in Chat" remains functional |

## Validation

All personalization default variables (`DEFAULT_FONT_SIZE`, `DEFAULT_FONT_FAMILY`, `DEFAULT_THEME`, `DEFAULT_GRADIENT_THEME`) are **validated** against their allowed values. If an invalid value is provided, the built-in default is silently used instead. No error is thrown and no warning is logged — this ensures the UI always renders correctly even with misconfigured env vars.

```bash
# This is fine — falls back to "medium" silently
DEFAULT_FONT_SIZE=huge

# This is fine — falls back to "dark" silently
DEFAULT_THEME=solarized
```

## Complete Example

A fully customized deployment:

```bash
# Branding
APP_NAME=Grid
TAGLINE=Enterprise AI Platform
LOGO_URL=/grid-logo.svg
LOGO_STYLE=white
FAVICON_URL=/grid-favicon.png
SUPPORT_EMAIL=support@grid.cisco.com
SHOW_POWERED_BY=false

# Gradient
GRADIENT_FROM=#1a1a2e
GRADIENT_TO=#16213e
SPINNER_COLOR=#4ecdc4

# Personalization defaults
DEFAULT_FONT_SIZE=medium
DEFAULT_FONT_FAMILY=ibm-plex
DEFAULT_THEME=dark
DEFAULT_GRADIENT_THEME=professional

# Header links
DOCS_URL=https://docs.grid.cisco.com
SOURCE_URL=https://github.com/cisco/grid

# Login page
ENABLED_INTEGRATION_ICONS=github,slack,aws,kubernetes,jira,argocd

# Features
WORKFLOW_RUNNER_ENABLED=true
```

## Docker and Kubernetes

### Docker Compose

Add customization variables to your `docker-compose.yaml`:

```yaml
services:
  caipe-ui:
    image: ghcr.io/cnoe-io/caipe-ui:latest
    environment:
      - APP_NAME=Grid
      - LOGO_STYLE=white
      - DEFAULT_THEME=dark
      - DEFAULT_FONT_FAMILY=ibm-plex
      - DEFAULT_GRADIENT_THEME=professional
      - GRADIENT_FROM=#1a1a2e
      - GRADIENT_TO=#16213e
      - SHOW_POWERED_BY=false
```

### Kubernetes ConfigMap

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: caipe-ui-customization
  namespace: caipe
data:
  APP_NAME: "Grid"
  LOGO_STYLE: "white"
  DEFAULT_THEME: "dark"
  DEFAULT_FONT_FAMILY: "ibm-plex"
  DEFAULT_GRADIENT_THEME: "professional"
  GRADIENT_FROM: "#1a1a2e"
  GRADIENT_TO: "#16213e"
  SHOW_POWERED_BY: "false"
  DOCS_URL: "https://docs.grid.cisco.com"
```

Reference in your Deployment:

```yaml
spec:
  containers:
    - name: caipe-ui
      envFrom:
        - configMapRef:
            name: caipe-ui-customization
```

### Helm Values

If using the CAIPE Helm chart, pass customization via values:

```yaml
ui:
  env:
    APP_NAME: Grid
    LOGO_STYLE: white
    DEFAULT_THEME: dark
    DEFAULT_FONT_FAMILY: ibm-plex
    DEFAULT_GRADIENT_THEME: professional
```

## Next Steps

- [Configuration Guide](configuration.md) — Core settings (connection, auth, storage)
- [Admin settings](../features/admin-settings.md) — Personal and platform Settings Center routes
- [Development Guide](development.md) — Local development setup
