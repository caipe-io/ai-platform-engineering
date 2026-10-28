# DevNet CAIPE Learning Lab Launcher

`prepare-caipe.sh` is the self-contained launcher for the DevNet Weather and
SD-WAN agent exercises. It calls the official installer, applies workspace
migrations, opts into guarded first-install recovery, and deploys the Weather
MCP sample. It does not create the learner's agents.

## Distribution

- Include the file at `/home/developer/src/prepare-caipe.sh` when building the
  DevNet image; or download this file from an immutable commit before running it.
- Lab navigation settings do not copy repository files into the pod.
- Keep the published lab download pinned to the reviewed commit containing this
  file. The installer and chart versions are separately pinned inside the script.
- This launcher currently depends on installer changes in
  [PR #3028](https://github.com/caipe-io/ai-platform-engineering/pull/3028).

## Environment

The pod supplies `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `DEVENV_APP_8081_URL`, and
`DEVENV_APP_8080_URL`. The launcher verifies the configured model, defaults to
`gpt-4o`, and never enables shell tracing. Authors can set `CAIPE_LAB_MODEL` to
a model served by their test provider.

The launcher waits up to five minutes for kind nodes to become Ready. Preparation
prints seven stages, a status message every 30 seconds during longer operations,
and a short error excerpt on failure. Full details go to `~/src/caipe-setup.log`.

Automatic pending-install recovery requires a local kind cluster managed
exclusively from this pod. See the installer's `--repair-pending-install` option.

## Validation Status

Fresh-pod validation of this distribution path and the full launcher is pending.
The individual installer migration initializer previously succeeded against an
existing local rc.12 deployment. A learner manually recovered an interrupted
DevNet install by reapplying saved Helm revision 1. Those results do not validate
this launcher's complete flow.
