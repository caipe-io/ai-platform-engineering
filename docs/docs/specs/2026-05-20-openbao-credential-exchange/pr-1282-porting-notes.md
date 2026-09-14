# PR #1282 Selective Porting Notes

Source PR: https://github.com/caipe-io/ai-platform-engineering/pull/1282
Title: Feature/caipe security UI v2
Author: Matt Shooshtari DevOps Alchemist (`cpumanaz`)
Commit author used in PR: Matthew Shooshtari (`mshoosht-cisco`) `mshoosht@cisco.com`

## Attribution Plan

Credential work in this feature must preserve PR #1282 contribution history when code is reused.

- Prefer cherry-picking isolated PR #1282 commits when they apply cleanly and the commit remains relevant.
- If a full cherry-pick is too broad, manually port only the needed implementation and cite the original PR/commit in the local commit body.
- Keep copied or adapted logic behind `CAIPE_CREDENTIALS_ENABLED` or another explicit feature toggle until this feature is ready.
- Do not attribute newly written credential-store code to PR #1282 unless it directly adapts that implementation.

## Relevant PR #1282 Inputs

- `d66880468442557d99324743e587bd7693cc7f0c` (`feat(security): add envelope encryption foundation for secrets at rest`) is the main prior-art input for envelope encryption patterns.
- `6ef54f49bbd7aaf73b9fca2c01c1f222bc44e8d6` (`feat(security): add key rotation pipeline for envelope-encrypted secrets`) is relevant for future rotation workflows, but this feature uses the new credential key-wrapper interface and AWS KMS/CMK wrapping strategy.
- `ec6d331e00144e06fbf24ed1011c9228efdc0330` (`feat(ops): system health dashboard, supervisor health endpoint, featu...`) is relevant if runtime feature flag UI concepts are ported later.

## Current Scope

This implementation starts with new credential feature flags, guardrails, and MongoDB envelope-encryption interfaces. The current files are not direct copies from PR #1282. Later encryption and rotation work should explicitly record whether it was cherry-picked, adapted, or newly implemented.
