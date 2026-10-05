/**
 * @jest-environment node
 *
 * Tests for GET /api/skills/update-skills
 *
 * Most behavior is shared with /api/skills/live-skills via the
 * `makeTemplateRouteHandler` factory in `_lib/template-route.ts`. The
 * 47-case live-skills test suite exercises all per-agent rendering,
 * sanitization, layout selection, and template-source precedence. This
 * file therefore covers ONLY the update-skills-specific surface area
 * (defaults + env-var keys + chart path) plus a smoke assertion that
 * the response shape hasn't drifted from live-skills.
 *
 * Adding fresh per-agent / per-scope assertions here would just duplicate
 * the live-skills tests against the same factory, so we deliberately
 * don't.
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
  // Default: no files exist anywhere — falls through to built-in template.
  mockExists.mockReturnValue(false);
  mockStat.mockReturnValue({ isFile: () => false, size: 0 });
  delete process.env.SKILLS_UPDATE_SKILLS_TEMPLATE;
  delete process.env.SKILLS_UPDATE_SKILLS_FILE;
  // Defensive: scrub the live-skills env keys too so a leaky harness
  // doesn't make us accidentally read the wrong template.
  delete process.env.SKILLS_LIVE_SKILLS_TEMPLATE;
  delete process.env.SKILLS_LIVE_SKILLS_FILE;
});

afterAll(() => {
  process.env = { ...ORIG_ENV };
});

// After the skills-only overhaul `?layout=` is silently accepted and
// ignored. We pass through whatever URL the test author wrote -- no
// auto-injection of legacy params is necessary.
const callGET = async (url: string) => {
  const res = await GET(new Request(url));
  return res.json() as Promise<unknown>;
};

describe('GET /api/skills/update-skills — defaults', () => {
  it('uses "update-caipe-skills" as the default command name', async () => {
    const data = await callGET(
      'https://app.example.com/api/skills/update-skills',
    );

    expect(data.defaults.command_name).toBe('update-caipe-skills');
    // The fallback template references the command name via the placeholder.
    // The renderer should also have used "update-caipe-skills" as the install path
    // basename for any per-agent rendering with a scope.
    expect(data.inputs.command_name).toBe('update-caipe-skills');
  });

  it('uses the update-skills description as the default description', async () => {
    const data = await callGET(
      'https://app.example.com/api/skills/update-skills',
    );

    expect(data.defaults.description).toMatch(/refresh.*locally-installed/i);
    expect(data.defaults.description).toMatch(/catalog/i);
    expect(data.template).toContain(
      'description: Refresh locally-installed CAIPE skills from the live catalog',
    );
    expect(data.template).not.toContain(
      'description: Browse and install skills from the CAIPE skill catalog',
    );
  });

  it('honors a custom command_name over the default', async () => {
    const data = await callGET(
      'https://app.example.com/api/skills/update-skills?command_name=refresh-skills',
    );

    expect(data.inputs.command_name).toBe('refresh-skills');
    // Defaults stay anchored to the route's own default — only the input
    // changes per request.
    expect(data.defaults.command_name).toBe('update-caipe-skills');
  });
});

describe('GET /api/skills/update-skills — template resolution', () => {
  it('reads SKILLS_UPDATE_SKILLS_TEMPLATE inline override', async () => {
    process.env.SKILLS_UPDATE_SKILLS_TEMPLATE = '---\ndescription: my custom updater\n---\n# body';

    const data = await callGET(
      'https://app.example.com/api/skills/update-skills',
    );

    expect(data.source).toBe('env:SKILLS_UPDATE_SKILLS_TEMPLATE');
    expect(data.canonical_template).toContain('my custom updater');
  });

  it('reads SKILLS_UPDATE_SKILLS_FILE when set and inline override is absent', async () => {
    process.env.SKILLS_UPDATE_SKILLS_FILE = '/etc/caipe/update-skills.md';
    mockExists.mockImplementation((p: string) =>
      String(p).endsWith('/etc/caipe/update-skills.md'),
    );
    mockStat.mockReturnValue({ isFile: () => true, size: 64 });
    mockRead.mockReturnValue('---\ndescription: from file\n---\n# body');

    const data = await callGET(
      'https://app.example.com/api/skills/update-skills',
    );

    expect(data.source).toBe('file:/etc/caipe/update-skills.md');
    expect(data.canonical_template).toContain('from file');
  });

  it('does NOT read SKILLS_LIVE_SKILLS_* env vars (route isolation)', async () => {
    // Set the live-skills env var to a marker. The update-skills route
    // must ignore it and fall through to its own resolution chain (which
    // will land on the built-in fallback since no fs is staged).
    process.env.SKILLS_LIVE_SKILLS_TEMPLATE = 'WRONG_TEMPLATE_SHOULD_BE_IGNORED';

    const data = await callGET(
      'https://app.example.com/api/skills/update-skills',
    );

    expect(data.canonical_template).not.toContain('WRONG_TEMPLATE_SHOULD_BE_IGNORED');
    expect(data.source).toBe('fallback');
  });

  it('looks up the chart-relative update-skills.md when env vars are unset', async () => {
    // The factory resolves `chartTemplatePath` against process.cwd() + ".."
    // so the path probed will end with "update-skills.md", not "live-skills.md".
    mockExists.mockImplementation((p: string) =>
      String(p).endsWith('/data/skills/update-skills.md'),
    );
    mockStat.mockReturnValue({ isFile: () => true, size: 128 });
    mockRead.mockReturnValue('---\ndescription: {{DESCRIPTION}}\n---\n# body');

    const data = await callGET(
      'https://app.example.com/api/skills/update-skills',
    );

    expect(data.source).toMatch(/file:.*update-skills\.md$/);
    expect(data.canonical_template).toContain('description: {{DESCRIPTION}}');
    expect(data.template).toContain(
      'description: Refresh locally-installed CAIPE skills from the live catalog',
    );
    expect(data.template).not.toContain(
      'description: Browse and install skills from the CAIPE skill catalog',
    );
  });
});

describe('GET /api/skills/update-skills — response shape parity', () => {
  it('returns the full live-skills response shape (no fields lost)', async () => {
    const data = await callGET(
      'https://app.example.com/api/skills/update-skills?scope=user',
    );

    // Spot-check the post-overhaul contract surface that the UI +
    // install.sh both depend on. Layout/format/fragment fields were
    // removed; if any of these REMAINING fields go missing we want a
    // loud failure.
    expect(data).toMatchObject({
      agent: expect.any(String),
      agent_fallback: expect.any(Boolean),
      label: expect.any(String),
      template: expect.any(String),
      install_paths: expect.any(Object),
      scope: 'user',
      scope_requested: 'user',
      scope_fallback: expect.any(Boolean),
      scopes_available: expect.any(Array),
      launch_guide: expect.any(String),
      agents: expect.any(Array),
      source: expect.any(String),
      inputs: expect.objectContaining({
        command_name: expect.any(String),
        base_url: expect.any(String),
      }),
      canonical_template: expect.any(String),
      placeholders: expect.arrayContaining([
        '{{COMMAND_NAME}}',
        '{{UPDATE_COMMAND_NAME}}',
        '{{DESCRIPTION}}',
        '{{BASE_URL}}',
        '{{ARG_REF}}',
      ]),
    });

    // install_paths[scope] is an ARRAY with the Claude-native and shared target paths.
    expect(Array.isArray(data.install_paths.user)).toBe(true);
    expect(data.install_paths.user).toEqual([
      '~/.claude/skills/update-caipe-skills/SKILL.md',
      '~/.agents/skills/update-caipe-skills/SKILL.md',
    ]);

    // Dropped legacy fields must not reappear.
    expect(data.format).toBeUndefined();
    expect(data.file_extension).toBeUndefined();
    expect(data.is_fragment).toBeUndefined();
    expect(data.layout).toBeUndefined();
    expect(data.layouts_available).toBeUndefined();
  });

  it('sets Cache-Control: no-store', async () => {
    const res = await GET(
      new Request('https://app.example.com/api/skills/update-skills'),
    );
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});
