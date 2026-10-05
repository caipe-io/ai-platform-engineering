/**
 * @jest-environment node
 *
 * Tests for GET /api/skills/live-skills after the skills-only overhaul.
 *
 * Covers:
 *   - Default (no query) renders Claude with default command/description
 *     and reports `agent_fallback: false`.
 *   - Per-agent rendering picks the right multi-target install paths and
 *     argRef token, and always emits `name:` + `description:` frontmatter.
 *   - Unknown agent ids fall back to Claude with `agent_fallback: true`.
 *   - Sanitization of `command_name`, `description`, and `base_url` rejects
 *     hostile inputs and falls back to safe defaults.
 *   - Template resolution order: SKILLS_LIVE_SKILLS_TEMPLATE env >
 *     SKILLS_LIVE_SKILLS_FILE env > chart-relative file > built-in fallback.
 *   - The response carries the catalog of all 5 supported agents and the
 *     canonical template for the UI.
 *   - `install_paths` per scope is an ARRAY with the single
 *     vendor-neutral target path.
 *   - `?layout=...` is silently accepted and ignored (back-compat).
 *   - Cache-Control: no-store is set.
 */

jest.mock('@/lib/mongodb', () => ({ isMongoDBConfigured: false }));

const mockNextResponseJson = jest.fn(
  (data: unknown, init?: { headers?: Record<string, string>; status?: number }) => ({
    json: async () => data,
    status: init?.status ?? 200,
    headers: new Map(Object.entries(init?.headers ?? {})),
  }),
);

jest.mock('next/server', () => ({
  NextResponse: { json: (...args: unknown[]) => mockNextResponseJson(...args) },
}));

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  statSync: jest.fn(),
  readFileSync: jest.fn(),
}));

import fs from 'fs';
import { GET } from '../route';

const mockExists = fs.existsSync as jest.Mock;
const mockStat = fs.statSync as jest.Mock;
const mockRead = fs.readFileSync as jest.Mock;

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  mockExists.mockReturnValue(false);
  mockStat.mockReturnValue({ isFile: () => false, size: 0 });
  delete process.env.SKILLS_LIVE_SKILLS_TEMPLATE;
  delete process.env.SKILLS_LIVE_SKILLS_FILE;
});

afterAll(() => {
  process.env = { ...ORIG_ENV };
});

const callGET = async (url: string) => {
  const res = await GET(new Request(url));
  return res.json() as Promise<unknown>;
};

describe('GET /api/skills/live-skills — defaults', () => {
  it('returns Claude rendering with default command/description when no query', async () => {
    const data = await callGET('https://app.example.com/api/skills/live-skills');

    expect(data.agent).toBe('claude');
    expect(data.agent_fallback).toBe(false);
    expect(data.label).toBe('Claude Code');
    // Without ?scope=, install_path is null and the UI must prompt the user.
    expect(data.install_path).toBeNull();
    expect(data.scope).toBeNull();
    expect(data.scope_requested).toBeNull();
    expect(data.scope_fallback).toBe(false);
    expect(data.scopes_available).toEqual(['user', 'project']);
    // install_paths is keyed by scope; Claude has a native discovery path
    // plus the shared agents path.
    expect(data.install_paths.user).toEqual([
      '~/.claude/skills/caipe-skills/SKILL.md',
      '~/.agents/skills/caipe-skills/SKILL.md',
    ]);
    expect(data.install_paths.project).toEqual([
      './.claude/skills/caipe-skills/SKILL.md',
      './.agents/skills/caipe-skills/SKILL.md',
    ]);

    // The default template uses {{ARG_REF}} which renders to $ARGUMENTS for
    // Claude. Verify it's substituted, not leaked.
    expect(data.template).toContain('$ARGUMENTS');
    expect(data.template).not.toContain('{{ARG_REF}}');
    // SKILL.md frontmatter must include name + description so the
    // agentskills.io spec recognises it.
    expect(data.template).toMatch(/^---\nname: caipe-skills\ndescription: /);

    // base_url defaults to the request origin
    expect(data.inputs.base_url).toBe('https://app.example.com');
    expect(data.inputs.command_name).toBe('caipe-skills');

    // Catalog of all 5 supported agents (continue and specify dropped).
    expect(Array.isArray(data.agents)).toBe(true);
    expect(data.agents).toHaveLength(5);
    const ids = data.agents.map((a: unknown) => a.id).sort();
    expect(ids).toEqual(['claude', 'codex', 'cursor', 'gemini', 'opencode']);

    expect(data.defaults.command_name).toBe('caipe-skills');
    expect(data.defaults.description.length).toBeGreaterThan(0);
  });

  it('sets Cache-Control: no-store', async () => {
    const res = await GET(
      new Request('https://app.example.com/api/skills/live-skills'),
    );
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('reports the source as fallback when no file/env source is configured', async () => {
    const data = await callGET('https://app.example.com/api/skills/live-skills');
    expect(data.source).toBe('fallback');
  });

  it('legacy ?layout= is silently accepted and ignored', async () => {
    // Pre-overhaul one-liners may still pass ?layout=commands or
    // ?layout=skills. The route MUST NOT 400 -- it should produce the
    // same SKILL.md output.
    for (const layout of ['commands', 'skills', 'nonsense']) {
      const data = await callGET(
        `https://app.example.com/api/skills/live-skills?agent=claude&scope=user&layout=${layout}`,
      );
      expect(data.agent).toBe('claude');
      expect(data.install_path).toBe('~/.claude/skills/caipe-skills/SKILL.md');
      // No legacy fields leak into the response (all dropped).
      expect(data.layout).toBeUndefined();
      expect(data.format).toBeUndefined();
      expect(data.file_extension).toBeUndefined();
      expect(data.is_fragment).toBeUndefined();
      expect(data.layouts_available).toBeUndefined();
    }
  });
});

describe('GET /api/skills/live-skills — per-agent rendering', () => {
  // After the overhaul every agent emits SKILL.md, with Claude using
  // its native .claude/skills discovery path first. After the 2026-05-04
  // cleanup, every agent also uses the same `$ARGUMENTS`
  // token: only Claude does template substitution per its docs;
  // Cursor/Codex/Gemini/opencode read SKILL.md verbatim and surface
  // the token as instructional text.
  it.each([
    ['claude', 'user', '~/.claude/skills/caipe-skills/SKILL.md', '$ARGUMENTS'],
    ['claude', 'project', './.claude/skills/caipe-skills/SKILL.md', '$ARGUMENTS'],
    ['cursor', 'user', '~/.agents/skills/caipe-skills/SKILL.md', '$ARGUMENTS'],
    ['cursor', 'project', './.agents/skills/caipe-skills/SKILL.md', '$ARGUMENTS'],
    ['codex', 'user', '~/.agents/skills/caipe-skills/SKILL.md', '$ARGUMENTS'],
    ['gemini', 'user', '~/.agents/skills/caipe-skills/SKILL.md', '$ARGUMENTS'],
    ['gemini', 'project', './.agents/skills/caipe-skills/SKILL.md', '$ARGUMENTS'],
    ['opencode', 'user', '~/.agents/skills/caipe-skills/SKILL.md', '$ARGUMENTS'],
  ])(
    'agent=%s scope=%s renders the expected SKILL.md path',
    async (agent, scope, installPath, argRef) => {
      const data = await callGET(
        `https://app.example.com/api/skills/live-skills?agent=${agent}&scope=${scope}`,
      );
      expect(data.agent).toBe(agent);
      expect(data.agent_fallback).toBe(false);
      // install_path is the first target path for display.
      expect(data.install_path).toBe(installPath);
      expect(data.scope).toBe(scope);
      expect(data.scope_fallback).toBe(false);
      expect(data.template).toContain(argRef);
      // SKILL.md frontmatter is mandatory.
      expect(data.template).toMatch(/^---\nname: caipe-skills\n/);
    },
  );

  it('install_paths contains Claude and shared agents trees for Claude', async () => {
    const data = await callGET(
      'https://app.example.com/api/skills/live-skills?agent=claude&scope=user',
    );
    expect(data.install_paths.user).toEqual([
      '~/.claude/skills/caipe-skills/SKILL.md',
      '~/.agents/skills/caipe-skills/SKILL.md',
    ]);
    expect(data.install_paths.project).toEqual([
      './.claude/skills/caipe-skills/SKILL.md',
      './.agents/skills/caipe-skills/SKILL.md',
    ]);
  });

  it('ignores invalid scope values and treats them as unset', async () => {
    const data = await callGET(
      'https://app.example.com/api/skills/live-skills?agent=claude&scope=root',
    );
    expect(data.scope_requested).toBeNull();
    expect(data.install_path).toBeNull();
    expect(data.scope_fallback).toBe(false);
  });

  it('falls back to Claude with agent_fallback=true for unknown agents', async () => {
    const data = await callGET(
      'https://app.example.com/api/skills/live-skills?agent=does-not-exist',
    );
    expect(data.agent).toBe('claude');
    expect(data.agent_fallback).toBe(true);
  });

  it('treats agent ids case-insensitively', async () => {
    const data = await callGET(
      'https://app.example.com/api/skills/live-skills?agent=GEMINI',
    );
    expect(data.agent).toBe('gemini');
    expect(data.agent_fallback).toBe(false);
  });

  it('continue and specify are no longer in the catalog', async () => {
    const data = await callGET(
      'https://app.example.com/api/skills/live-skills',
    );
    const ids = data.agents.map((a: unknown) => a.id);
    expect(ids).not.toContain('continue');
    expect(ids).not.toContain('specify');
  });

  it('continue and specify fall back to Claude when explicitly requested', async () => {
    const cont = await callGET(
      'https://app.example.com/api/skills/live-skills?agent=continue',
    );
    expect(cont.agent).toBe('claude');
    expect(cont.agent_fallback).toBe(true);

    const spec = await callGET(
      'https://app.example.com/api/skills/live-skills?agent=specify',
    );
    expect(spec.agent).toBe('claude');
    expect(spec.agent_fallback).toBe(true);
  });
});

describe('GET /api/skills/live-skills — input sanitization', () => {
  it('substitutes a clean command_name into install path and body', async () => {
    const data = await callGET(
      'https://app.example.com/api/skills/live-skills?command_name=my-skills&scope=project',
    );
    expect(data.inputs.command_name).toBe('my-skills');
    expect(data.install_path).toBe('./.claude/skills/my-skills/SKILL.md');
    expect(data.install_paths.user).toEqual([
      '~/.claude/skills/my-skills/SKILL.md',
      '~/.agents/skills/my-skills/SKILL.md',
    ]);
    expect(data.template).toContain('/my-skills');
  });

  it.each([
    ['rm -rf /', 'shell metachars'],
    ['../../etc/passwd', 'path traversal'],
    ['name with spaces', 'whitespace'],
    ['name;injection', 'semicolon'],
    ['<script>', 'angle brackets'],
    ['', 'empty string (trimmed)'],
    ['   ', 'whitespace-only'],
    ['x'.repeat(65), 'too long (>64 chars)'],
  ])('rejects hostile command_name (%s) and uses default "caipe-skills"', async (bad) => {
    const data = await callGET(
      `https://app.example.com/api/skills/live-skills?command_name=${encodeURIComponent(
        bad,
      )}&scope=project`,
    );
    expect(data.inputs.command_name).toBe('caipe-skills');
    expect(data.install_path).toBe('./.claude/skills/caipe-skills/SKILL.md');
  });

  it('caps description at 500 chars', async () => {
    const long = 'a'.repeat(600);
    const data = await callGET(
      `https://app.example.com/api/skills/live-skills?description=${encodeURIComponent(long)}`,
    );
    expect(data.inputs.description.length).toBe(500);
  });

  it('uses a custom base_url when valid (https)', async () => {
    const data = await callGET(
      'https://app.example.com/api/skills/live-skills?base_url=https://gateway.test.io',
    );
    expect(data.inputs.base_url).toBe('https://gateway.test.io');
    expect(data.template).toContain('https://gateway.test.io/api/skills');
  });

  it('strips trailing slashes from base_url', async () => {
    const data = await callGET(
      'https://app.example.com/api/skills/live-skills?base_url=https://gateway.test.io/',
    );
    expect(data.inputs.base_url).toBe('https://gateway.test.io');
  });

  it.each([
    ['javascript:alert(1)', 'javascript: scheme'],
    ['file:///etc/passwd', 'file: scheme'],
    ['ftp://example.com', 'ftp: scheme'],
    ['http://user:pass@example.com', 'embedded credentials'],
    ['not a url', 'invalid URL'],
  ])('rejects hostile base_url (%s) and falls back to request origin', async (bad) => {
    const data = await callGET(
      `https://app.example.com/api/skills/live-skills?base_url=${encodeURIComponent(bad)}`,
    );
    expect(data.inputs.base_url).toBe('https://app.example.com');
  });
});

describe('GET /api/skills/live-skills — template resolution order', () => {
  it('SKILLS_LIVE_SKILLS_TEMPLATE env wins over everything else', async () => {
    process.env.SKILLS_LIVE_SKILLS_TEMPLATE =
      '---\ndescription: From env\n---\nbody from env {{ARG_REF}}\n';
    process.env.SKILLS_LIVE_SKILLS_FILE = '/path/to/file.md';
    mockExists.mockReturnValue(true);
    mockStat.mockReturnValue({ isFile: () => true, size: 100 });
    mockRead.mockReturnValue(
      '---\ndescription: From file\n---\nbody from file\n',
    );

    const data = await callGET(
      'https://app.example.com/api/skills/live-skills',
    );
    expect(data.source).toBe('env:SKILLS_LIVE_SKILLS_TEMPLATE');
    expect(data.template).toContain('body from env');
    expect(data.template).not.toContain('body from file');
    expect(data.template).toContain('description: From env');
  });

  it('SKILLS_LIVE_SKILLS_FILE wins when SKILLS_LIVE_SKILLS_TEMPLATE is empty', async () => {
    process.env.SKILLS_LIVE_SKILLS_FILE = '/var/data/live-skills.md';
    mockExists.mockImplementation((p: string) => p === '/var/data/live-skills.md');
    mockStat.mockReturnValue({ isFile: () => true, size: 100 });
    mockRead.mockReturnValue(
      '---\ndescription: From file\n---\nbody from file {{ARG_REF}}\n',
    );

    const data = await callGET(
      'https://app.example.com/api/skills/live-skills',
    );
    expect(data.source).toBe('file:/var/data/live-skills.md');
    expect(data.template).toContain('body from file');
    expect(data.template).toContain('description: From file');
  });

  it('rejects oversized files (>256 KiB) and falls through to the next source', async () => {
    process.env.SKILLS_LIVE_SKILLS_FILE = '/huge.md';
    mockExists.mockReturnValue(true);
    mockStat.mockReturnValue({ isFile: () => true, size: 257 * 1024 });
    mockRead.mockReturnValue('would-be-content');

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const data = await callGET(
      'https://app.example.com/api/skills/live-skills',
    );
    warnSpy.mockRestore();

    expect(data.source).toBe('fallback');
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('ignores SKILLS_LIVE_SKILLS_FILE when the path is not a regular file', async () => {
    process.env.SKILLS_LIVE_SKILLS_FILE = '/etc';
    mockExists.mockReturnValue(true);
    mockStat.mockReturnValue({ isFile: () => false, size: 0 });
    const data = await callGET(
      'https://app.example.com/api/skills/live-skills',
    );
    expect(data.source).toBe('fallback');
  });

  it('treats a whitespace-only SKILLS_LIVE_SKILLS_TEMPLATE as unset', async () => {
    process.env.SKILLS_LIVE_SKILLS_TEMPLATE = '   \n  ';
    const data = await callGET(
      'https://app.example.com/api/skills/live-skills',
    );
    expect(data.source).toBe('fallback');
  });
});

describe('GET /api/skills/live-skills — response shape', () => {
  it('exposes placeholders, defaults, and the canonical template for the UI', async () => {
    const data = await callGET(
      'https://app.example.com/api/skills/live-skills',
    );
    expect(data.placeholders).toEqual([
      '{{COMMAND_NAME}}',
      '{{UPDATE_COMMAND_NAME}}',
      '{{DESCRIPTION}}',
      '{{BASE_URL}}',
      '{{ARG_REF}}',
    ]);
    expect(typeof data.canonical_template).toBe('string');
    expect(data.canonical_template.length).toBeGreaterThan(0);
  });

  it('agents catalog reflects the user-supplied command_name in install paths', async () => {
    const data = await callGET(
      'https://app.example.com/api/skills/live-skills?command_name=catalog',
    );
    const claudeMeta = data.agents.find((a: unknown) => a.id === 'claude');
    const codexMeta = data.agents.find((a: unknown) => a.id === 'codex');
    const opencodeMeta = data.agents.find((a: unknown) => a.id === 'opencode');

    // Claude has a native discovery path plus the shared target.
    expect(claudeMeta.install_paths.user).toEqual([
      '~/.claude/skills/catalog/SKILL.md',
      '~/.agents/skills/catalog/SKILL.md',
    ]);
    expect(claudeMeta.install_paths.project).toEqual([
      './.claude/skills/catalog/SKILL.md',
      './.agents/skills/catalog/SKILL.md',
    ]);
    expect(claudeMeta.scopes_available).toEqual(['user', 'project']);

    // All 5 agents support both scopes after the overhaul.
    expect(codexMeta.install_paths.user).toEqual([
      '~/.agents/skills/catalog/SKILL.md',
    ]);
    expect(codexMeta.scopes_available).toEqual(['user', 'project']);
    expect(opencodeMeta.scopes_available).toEqual(['user', 'project']);
  });

  it('does not expose dropped legacy fields on the response root', async () => {
    const data = await callGET(
      'https://app.example.com/api/skills/live-skills?agent=claude&scope=user',
    );
    // These fields existed pre-overhaul and have been removed. Pin
    // their absence so a future refactor can't accidentally re-add
    // them under a new code path.
    expect(data.format).toBeUndefined();
    expect(data.file_extension).toBeUndefined();
    expect(data.is_fragment).toBeUndefined();
    expect(data.layout).toBeUndefined();
    expect(data.layout_requested).toBeUndefined();
    expect(data.layout_fallback).toBeUndefined();
    expect(data.layouts_available).toBeUndefined();
  });

  it('does not expose dropped legacy fields on agent catalog entries', async () => {
    const data = await callGET(
      'https://app.example.com/api/skills/live-skills',
    );
    for (const a of data.agents) {
      expect(a.ext).toBeUndefined();
      expect(a.format).toBeUndefined();
      expect(a.is_fragment).toBeUndefined();
      expect(a.default_layout).toBeUndefined();
      expect(a.install_paths_by_layout).toBeUndefined();
    }
  });
});
