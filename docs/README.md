# CAIPE (Community AI Platform Engineering) Documentation Website

This website is built using [Docusaurus](https://docusaurus.io/), a modern static website generator.

## Installation

```bash
npm install
```

## Local Development with auto-reload

> **Note:** This site will auto-reload on new changes

```bash
npm run start
```

This command starts a local development server and opens up a browser window. Most changes are reflected live without having to restart the server.

## Build Static Site

```bash
npm run build
```

This command generates static content into the `build` directory and can be served using any static contents hosting service.

## Serve Static Site

```bash
npm run serve
```

## Deployment with Github Actions

[![Publish Docs](https://github.com/caipe-io/ai-platform-engineering/actions/workflows/publish-gh-pages.yml/badge.svg)](https://github.com/caipe-io/ai-platform-engineering/actions/workflows/publish-gh-pages.yml)

## Foundation branding

- The homepage uses the Sandbox statement from the [CNCF website guidelines](https://github.com/cncf/foundation/blob/main/policies-guidance/website-guidelines.md).
- A CNCF Sandbox Project link appears in the hero alongside the OSS and GitHub Stars badges and opens CAIPE's landscape entry.
- The shared footer carries the LF Projects copyright and policy link.
- Official, unmodified logos are served locally from `static/img/foundation/`:
  - CNCF [color](https://github.com/cncf/artwork/blob/main/other/cncf/horizontal/color/cncf-color.svg) and [white](https://github.com/cncf/artwork/blob/main/other/cncf/horizontal/white/cncf-white.svg) variants for light and dark themes.
  - Linux Foundation [stacked white logo](https://www.linuxfoundation.org/hubfs/lf-stacked-white.svg) for the dark footer.
- Preserve logo proportions, colors, and clear space when updating the layout. See the [CNCF](https://www.cncf.io/brand-guidelines/) and [Linux Foundation](https://www.linuxfoundation.org/brand-guidelines) brand guidelines.
