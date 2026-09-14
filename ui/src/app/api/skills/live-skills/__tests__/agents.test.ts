/**
 * @jest-environment node
 *
 * Unit tests for the live-skills agent registry and renderer (skills-only
 * overhaul). Pin the user-visible contract:
 *   - Each shipped agent has a coherent spec (id, install paths, argRef).
 *   - `installPaths[scope]` is always an array of universal SKILL.md
 *     paths so a single install satisfies every supported agent.
 *   - parseFrontmatter splits canonical templates and forwards the
 *     security-relevant frontmatter keys (disable-model-invocation,
 *     allowed-tools).
 *   - Placeholders are substituted in body, install paths, and launch
 *     guides; no `{{...}}` token leaks through.
 *   - Per-agent rendering produces a canonical SKILL.md with `name:` +
 *     `description:` frontmatter.
 *   - The legacy `description: {{DESCRIPTION}}` placeholder is treated
 *     as missing (regression for PR #1268 / Jeff Napper #4).
 */

import {
  AGENTS,
  DEFAULT_AGENT_ID,
  parseFrontmatter,
  scopesAvailableFor,
  substitutePlaceholders,
  renderForAgent,
  type AgentScope,
  type AgentSpec,
  type RenderInputs,
} from '../agents';

const CANONICAL = `---
description: Browse and install skills from the CAIPE skill catalog
---

## User Input

\`\`\`text
{{ARG_REF}}
\`\`\`

## Steps

1. Search at {{BASE_URL}}/api/skills.
2. Slash command: /{{COMMAND_NAME}}.
`;

const baseInputs = (overrides: Partial<RenderInputs> = {}): RenderInputs => ({
  canonicalTemplate: CANONICAL,
  commandName: 'caipe-skills',
  description: '',
  baseUrl: 'https://gateway.example.com',
  ...overrides,
});

describe('AGENTS registry', () => {
  it('contains the five shipped agents', () => {
    expect(Object.keys(AGENTS).sort()).toEqual([
      'claude',
      'codex',
      'cursor',
      'gemini',
      'opencode',
    ]);
  });

  it('has dropped continue and specify (skills-only overhaul)', () => {
    // Regression: retired command/config adapters stay out of the skill registry.
    // were removed when every supported agent standardized on the
    // agentskills.io SKILL.md format.
    expect((AGENTS as Record<string, unknown>).continue).toBeUndefined();
    expect((AGENTS as Record<string, unknown>).specify).toBeUndefined();
  });

  it('uses claude as the default agent', () => {
    expect(DEFAULT_AGENT_ID).toBe('claude');
    expect(AGENTS[DEFAULT_AGENT_ID]).toBeDefined();
  });

  describe.each(Object.values(AGENTS))('spec for %s', (agent: AgentSpec) => {
    it('has stable, well-formed metadata', () => {
      // id must be URL-safe (used in ?agent= query) and lowercase
      expect(agent.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(agent.label.length).toBeGreaterThan(0);

      // Every agent supports BOTH user and project scope (universal paths).
      const scopes = scopesAvailableFor(agent);
      expect(scopes).toEqual(['user', 'project']);

      // Each scope's installPaths is a non-empty array of templates that
      // each contain `{name}` and end in /SKILL.md.
      for (const s of scopes) {
        const paths = agent.installPaths[s]!;
        expect(Array.isArray(paths)).toBe(true);
        expect(paths.length).toBeGreaterThan(0);
        for (const p of paths) {
          expect(p).toContain('{name}');
          expect(p.endsWith('/SKILL.md')).toBe(true);
          // No raw shell metacharacters.
          expect(p).not.toMatch(/[;&|`$()<>]/);
        }
      }

      // User-scope paths start with `~/`; project-scope paths start
      // with `./` (forward slash for shell-snippet unambiguity).
      for (const p of agent.installPaths.user!) {
        expect(p.startsWith('~/')).toBe(true);
      }
      for (const p of agent.installPaths.project!) {
        expect(p.startsWith('./')).toBe(true);
      }

      // launch guide must reference the slash command (`{name}`) at least
      // once so users learn the actual invocation syntax.
      expect(agent.launchGuide).toContain('{name}');

      // argRef is now standardized on Claude's `$ARGUMENTS` token for
      // every agent. Only Claude does template substitution per its
      // upstream docs; the other four read SKILL.md verbatim and
      // surface the token as instructional text the model interprets.
      // See agents.ts module header for citations.
      expect(agent.argRef).toBe('$ARGUMENTS');
    });

    it('docs URL, when present, is https', () => {
      if (agent.docsUrl) {
        expect(agent.docsUrl.startsWith('https://')).toBe(true);
      }
    });
  });

  it('every agent uses the unified $ARGUMENTS argRef token', () => {
    // Cleanup (2026-05-04): previously codex/gemini were configured
    // with `$1` on the assumption their slash-command runtimes did
    // positional substitution. The published docs for both confirm
    // they do NOT substitute SKILL.md bodies at all -- they just
    // read the file and let the model reason about user intent.
    // Standardizing on `$ARGUMENTS` keeps the rendered file byte-identical
    // across every agent that reads the single ~/.agents/skills tree.
    for (const agent of Object.values(AGENTS)) {
      expect(agent.argRef).toBe('$ARGUMENTS');
    }
  });

  it('installs Claude skills to the native Claude discovery path too', () => {
    // assisted-by Codex Codex-sonnet-4-6
    expect(AGENTS.claude.installPaths.user).toEqual([
      '~/.claude/skills/{name}/SKILL.md',
      '~/.agents/skills/{name}/SKILL.md',
    ]);
    expect(AGENTS.claude.installPaths.project).toEqual([
      './.claude/skills/{name}/SKILL.md',
      './.agents/skills/{name}/SKILL.md',
    ]);
  });

  it('non-Claude agents install only to the vendor-neutral skills tree', () => {
    for (const agent of Object.values(AGENTS).filter((a) => a.id !== 'claude')) {
      const userPaths = agent.installPaths.user!;
      const projectPaths = agent.installPaths.project!;
      expect(userPaths).toEqual(['~/.agents/skills/{name}/SKILL.md']);
      expect(projectPaths).toEqual(['./.agents/skills/{name}/SKILL.md']);
    }
  });

  it('explains Claude catalog, refresh, and local skill invocation without HTML entities', () => {
    const guide = AGENTS.claude.launchGuide
      .replace(/\{name\}/g, 'caipe-skills')
      .replace(/\{updateName\}/g, 'update-caipe-skills');

    expect(guide).not.toContain('&mdash;');
    expect(guide).not.toContain('npm install -g @anthropic-ai/claude-code');
    expect(guide).not.toContain('brew install --cask claude-code');
    expect(guide).not.toContain('**Install Claude Code**');
    expect(guide).toContain(
      '[Claude Code quickstart](https://code.claude.com/docs/en/quickstart)',
    );
    expect(guide).toContain('`/caipe-skills`: browse the catalog');
    expect(guide).toContain('`/caipe-skills kubernetes`: search');
    expect(guide).toContain(
      '`/caipe-skills run create-ci-pipeline`: fetch and execute inline',
    );
    expect(guide).toContain(
      '`/update-caipe-skills`: install or refresh on-disk skill copies',
    );
    expect(guide).toContain(
      '`/create-ci-pipeline`: run the locally installed skill directly',
    );
    expect(guide).not.toContain('`/skills install create-ci-pipeline`');
  });

  it('links Cursor setup to the product get-started page', () => {
    const guide = AGENTS.cursor.launchGuide
      .replace(/\{name\}/g, 'caipe-skills')
      .replace(/\{updateName\}/g, 'update-caipe-skills');

    expect(guide).not.toContain('**Install Cursor**');
    expect(guide).toContain('[Cursor get started](https://cursor.com/get-started)');
  });

  it('keeps launch guides free of literal HTML dash entities', () => {
    for (const agent of Object.values(AGENTS)) {
      expect(agent.launchGuide).not.toContain('&mdash;');
    }
  });
});

describe('parseFrontmatter', () => {
  it('extracts a single-line description and strips the fence', () => {
    const out = parseFrontmatter(CANONICAL);
    expect(out.description).toBe(
      'Browse and install skills from the CAIPE skill catalog',
    );
    expect(out.body.startsWith('## User Input')).toBe(true);
    expect(out.body).not.toContain('---');
    expect(out.preservedFrontmatter).toEqual([]);
  });

  it('returns empty description and full body when no frontmatter', () => {
    const input = '## Heading\n\nbody\n';
    const out = parseFrontmatter(input);
    expect(out.description).toBe('');
    expect(out.body).toBe(input);
    expect(out.preservedFrontmatter).toEqual([]);
  });

  it('drops `name:` and other unknown frontmatter keys', () => {
    // The renderer always emits a canonical `name:` matching the
    // directory, so any incoming `name:` in the source template MUST
    // be dropped to avoid duplication.
    const input = '---\nname: drop-me\ntitle: foo\nauthor: bar\n---\nbody\n';
    const out = parseFrontmatter(input);
    expect(out.description).toBe('');
    expect(out.body).toBe('body\n');
    expect(out.preservedFrontmatter).toEqual([]);
  });

  it('preserves disable-model-invocation and allowed-tools verbatim', () => {
    // T008/T009: the two helper templates declare these keys to
    // pre-approve the python catalog helper and stop Claude Code from
    // nagging the user on every invocation. The renderer must forward
    // them into the rendered SKILL.md unchanged.
    const input =
      '---\n' +
      'description: x\n' +
      'disable-model-invocation: true\n' +
      'allowed-tools: ["Bash(python3 /tmp/foo.py*)"]\n' +
      '---\n' +
      'body\n';
    const out = parseFrontmatter(input);
    expect(out.description).toBe('x');
    expect(out.preservedFrontmatter).toEqual([
      'disable-model-invocation: true',
      'allowed-tools: ["Bash(python3 /tmp/foo.py*)"]',
    ]);
    expect(out.body).toBe('body\n');
  });

  it('only consumes the first --- block, leaving inline --- alone', () => {
    const input = '---\ndescription: x\n---\nbefore\n---\nafter\n';
    const out = parseFrontmatter(input);
    expect(out.description).toBe('x');
    expect(out.body).toBe('before\n---\nafter\n');
  });

  it('handles trailing whitespace on the description line', () => {
    const input = '---\ndescription:   spaced out   \n---\nbody\n';
    const out = parseFrontmatter(input);
    expect(out.description).toBe('spaced out');
  });
});

describe('substitutePlaceholders', () => {
  it('replaces all four placeholders globally', () => {
    const body =
      'cmd=/{{COMMAND_NAME}} desc={{DESCRIPTION}} url={{BASE_URL}} arg={{ARG_REF}}\n' +
      'again /{{COMMAND_NAME}} {{ARG_REF}}';
    const out = substitutePlaceholders(body, {
      commandName: 'caipe-skills',
      updateCommandName: 'update-caipe-skills',
      description: 'Catalog',
      baseUrl: 'https://x',
      argRef: '$1',
    });
    expect(out).toBe(
      'cmd=/caipe-skills desc=Catalog url=https://x arg=$1\nagain /caipe-skills $1',
    );
    expect(out).not.toContain('{{');
  });

  it('does not rewrite unknown {{...}} tokens', () => {
    const body = '{{UNKNOWN}} {{COMMAND_NAME}}';
    const out = substitutePlaceholders(body, {
      commandName: 'x',
      updateCommandName: 'update-x',
      description: 'd',
      baseUrl: 'u',
      argRef: 'a',
    });
    expect(out).toBe('{{UNKNOWN}} x');
  });
});

describe('renderForAgent — universal SKILL.md output', () => {
  it.each(['claude', 'cursor', 'codex', 'gemini', 'opencode'])(
    '%s: emits canonical SKILL.md with name + description frontmatter',
    (id) => {
      const scope: AgentScope = 'user';
      const out = renderForAgent(AGENTS[id], baseInputs({ scope }));
      expect(out.scope).toBe(scope);
      expect(out.scope_fallback).toBe(false);

      // Canonical frontmatter: name (matches directory) + description.
      expect(out.template).toMatch(/^---\nname: caipe-skills\ndescription: .+\n---\n\n/);

      // No leftover placeholders.
      expect(out.template).not.toContain('{{ARG_REF}}');
      expect(out.template).not.toContain('{{COMMAND_NAME}}');
      expect(out.template).not.toContain('{{BASE_URL}}');
      expect(out.template).not.toContain('{{DESCRIPTION}}');

      // install_path is the vendor-neutral target path with `{name}`
      // substituted.
      expect(out.install_path).not.toBeNull();
      expect(out.install_path!.endsWith('/caipe-skills/SKILL.md')).toBe(true);
      expect(out.install_path).not.toContain('{name}');

      if (id === 'claude') {
        expect(out.install_paths.user).toEqual([
          '~/.claude/skills/caipe-skills/SKILL.md',
          '~/.agents/skills/caipe-skills/SKILL.md',
        ]);
        expect(out.install_paths.project).toEqual([
          './.claude/skills/caipe-skills/SKILL.md',
          './.agents/skills/caipe-skills/SKILL.md',
        ]);
      } else {
        expect(out.install_paths.user).toEqual([
          '~/.agents/skills/caipe-skills/SKILL.md',
        ]);
        expect(out.install_paths.project).toEqual([
          './.agents/skills/caipe-skills/SKILL.md',
        ]);
      }
      for (const p of out.install_paths.user!) {
        expect(p.endsWith('/caipe-skills/SKILL.md')).toBe(true);
      }
    },
  );

  it('every agent renders the unified $ARGUMENTS token in the SKILL.md body', () => {
    // Cleanup (2026-05-04): codex/gemini previously rendered with `$1`.
    // Their docs confirm no substitution happens server-side, so the
    // token's only role is instructional. Standardizing on
    // `$ARGUMENTS` keeps the rendered file byte-identical across
    // every install location.
    for (const agent of Object.values(AGENTS)) {
      const out = renderForAgent(agent, baseInputs({ scope: 'user' }));
      expect(out.template).toContain('$ARGUMENTS');
      expect(out.template).not.toContain('$1');
    }
  });

  it('substitutes a custom command name into both body and install paths', () => {
    const out = renderForAgent(
      AGENTS.claude,
      baseInputs({ commandName: 'my-skills', scope: 'project' }),
    );
    expect(out.install_path).toBe('./.claude/skills/my-skills/SKILL.md');
    expect(out.install_paths.project).toEqual([
      './.claude/skills/my-skills/SKILL.md',
      './.agents/skills/my-skills/SKILL.md',
    ]);
    expect(out.install_paths.user).toEqual([
      '~/.claude/skills/my-skills/SKILL.md',
      '~/.agents/skills/my-skills/SKILL.md',
    ]);
    expect(out.template).toContain('/my-skills');
    expect(out.launch_guide).toContain('/my-skills');
  });

  it('falls back to the canonical description when input is empty', () => {
    const out = renderForAgent(AGENTS.claude, baseInputs({ description: '' }));
    expect(out.template).toContain(
      'description: Browse and install skills from the CAIPE skill catalog',
    );
  });

  it('uses the explicit input description when provided', () => {
    const out = renderForAgent(
      AGENTS.claude,
      baseInputs({ description: 'Custom catalog' }),
    );
    expect(out.template).toContain('description: Custom catalog');
  });

  it('treats an unsubstituted {{DESCRIPTION}} placeholder as missing', () => {
    // Regression for PR #1268 review feedback (Jeff Napper #4).
    const placeholderTemplate =
      '---\n' +
      'description: {{DESCRIPTION}}\n' +
      '---\n' +
      '\n' +
      'Body using {{ARG_REF}}.\n';

    const out = renderForAgent(
      AGENTS.claude,
      baseInputs({ canonicalTemplate: placeholderTemplate, description: '' }),
    );
    expect(out.template).toContain(
      'description: Browse and install skills from the CAIPE skill catalog',
    );
    expect(out.template).not.toContain('{{DESCRIPTION}}');
    expect(out.template).not.toContain('description: "{{DESCRIPTION}}"');

    const overridden = renderForAgent(
      AGENTS.claude,
      baseInputs({
        canonicalTemplate: placeholderTemplate,
        description: 'Custom catalog',
      }),
    );
    expect(overridden.template).toContain('description: Custom catalog');
    expect(overridden.template).not.toContain('{{DESCRIPTION}}');
  });

  it('forwards disable-model-invocation + allowed-tools into rendered output', () => {
    // T008/T009: the helpers' frontmatter must round-trip from source
    // template into the rendered SKILL.md so Claude Code pre-approves
    // the python catalog helper invocations.
    const helperTemplate =
      '---\n' +
      'description: Helper desc\n' +
      'disable-model-invocation: true\n' +
      'allowed-tools: ["Bash(python3 ~/.config/caipe/caipe-skills.py*)"]\n' +
      '---\n' +
      '\n' +
      'Body.\n';
    const out = renderForAgent(
      AGENTS.claude,
      baseInputs({ canonicalTemplate: helperTemplate, scope: 'user' }),
    );
    expect(out.template).toContain('disable-model-invocation: true');
    expect(out.template).toContain(
      'allowed-tools: ["Bash(python3 ~/.config/caipe/caipe-skills.py*)"]',
    );
    expect(out.template).toMatch(
      /^---\nname: caipe-skills\ndescription: .+\ndisable-model-invocation: true\nallowed-tools: .+\n---\n\n/,
    );
  });
});

describe('renderForAgent — launch_guide', () => {
  it('substitutes {name} with the slash-command name', () => {
    // Each launchGuide references `{name}` at least once (enforced by
    // the schema test above). After the 2026-05-04 cleanup the Gemini
    // guide invokes the skill descriptively (e.g. "Use the cat skill")
    // rather than via `/<name>`, so we assert the name appears -- the
    // exact prefix (`/` vs descriptive prose) is agent-specific.
    const out = renderForAgent(AGENTS.gemini, baseInputs({ commandName: 'cat' }));
    expect(out.launch_guide).toContain('cat');
    expect(out.launch_guide).not.toContain('{name}');
  });

  it('preserves the agent label and docs URL in the result', () => {
    const out = renderForAgent(AGENTS.cursor, baseInputs());
    expect(out.label).toBe(AGENTS.cursor.label);
    expect(out.docs_url).toBe(AGENTS.cursor.docsUrl);
  });
});

describe('renderForAgent — base URL handling', () => {
  it('surfaces the provided base URL inside the body', () => {
    const out = renderForAgent(
      AGENTS.claude,
      baseInputs({ baseUrl: 'https://other.example.com' }),
    );
    expect(out.template).toContain('https://other.example.com/api/skills');
    expect(out.template).not.toContain('https://gateway.example.com');
  });
});

describe('renderForAgent — scope handling', () => {
  it('returns null install_path when no scope is requested', () => {
    const out = renderForAgent(AGENTS.claude, baseInputs({ scope: null }));
    expect(out.install_path).toBeNull();
    expect(out.scope).toBeNull();
    expect(out.scope_fallback).toBe(false);
    // Template still renders so the UI can show a preview.
    expect(out.template).toContain('$ARGUMENTS');
  });
});
