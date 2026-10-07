// Copyright CAIPE Contributors (https://caipe.io)
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for RunHistory — IMP-13 deep-link surface.
 *
 * Covers:
 *  - Run rows that carry ``conversation_id`` render an "Open in chat"
 *    deep-link to ``/chat/<id>`` when expanded.
 *  - Rows without ``conversation_id`` (chat publishing disabled, or
 *    runs that pre-date IMP-13) do NOT render the link, so the row
 *    stays tidy in those modes.
 *  - The link uses the run's actual ``conversation_id`` -- a regression
 *    on the URL shape would silently 404 from /chat/[uuid].
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// next/link is a server-aware component; Jest renders it fine but we
// mock it to a plain anchor so we can read the href off the DOM
// without pulling in the Next.js runtime.
jest.mock('next/link', () => {
  // eslint-disable-next-line react/display-name
  return ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
});

// Lucide icons render as SVGs that don't matter for these assertions;
// stub them to bare spans to keep the test output readable and avoid
// any Jest/Next ESM friction with the real package.
jest.mock('lucide-react', () => ({
  RefreshCw: (props: Record<string, unknown>) => <span data-testid="icon-refresh" {...props} />,
  ChevronDown: (props: Record<string, unknown>) => <span data-testid="icon-down" {...props} />,
  ChevronRight: (props: Record<string, unknown>) => <span data-testid="icon-right" {...props} />,
  MessageSquare: (props: Record<string, unknown>) => <span data-testid="icon-chat" {...props} />,
  Send: () => <span />,
}));

jest.mock('@/components/shared/timeline/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="markdown-renderer">{content}</div>
  ),
}));

// The component fetches via `autonomousApi.listRuns`; we stub the
// whole module so each test can hand-tailor the returned runs.
const mockListRuns = jest.fn();
const mockOpenChat = jest.fn();
const mockListChats = jest.fn();
const mockPush = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('../api', () => ({
  autonomousApi: {
    listRuns: (...args: unknown[]) => mockListRuns(...args),
    openFollowUpChat: (...args: unknown[]) => mockOpenChat(...args),
    listFollowUpChats: (...args: unknown[]) => mockListChats(...args),
  },
  AutonomousApiError: class extends Error {
    status = 0;
    detail: unknown = null;
  },
}));

import { RunHistory } from '../RunHistory';
import type { TaskRun } from '../types';

function makeRun(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    run_id: 'r-1',
    task_id: 't-1',
    task_name: 'Daily PR sweep',
    status: 'success',
    started_at: '2026-04-19T10:00:00Z',
    finished_at: '2026-04-19T10:00:05Z',
    response_preview: 'all good',
    error: null,
    conversation_id: '11111111-1111-1111-1111-111111111111',
    execution_context_id: 'isolated-run-context',
    ...overrides,
  };
}

beforeEach(() => {
  mockListRuns.mockReset();
  mockOpenChat.mockReset();
  mockListChats.mockReset().mockResolvedValue({});
  mockPush.mockReset();
});

afterEach(() => {
  // The component installs a 5s polling interval; flush any pending
  // timers so they don't leak between tests.
  jest.useRealTimers();
});

describe('RunHistory deep-link to chat', () => {
  it('renders Open-in-chat link for runs with conversation_id when expanded', async () => {
    const run = makeRun();
    mockListRuns.mockResolvedValue([run]);

    render(<RunHistory taskId="t-1" />);

    // Wait for the row to land in the DOM.
    const row = await screen.findByText(run.run_id);
    fireEvent.click(row);

    const link = await screen.findByTestId('run-chat-link');
    expect(link).toHaveAttribute('href', `/chat/${run.conversation_id}`);
    // Accessible label used by screen readers identifies which run
    // the deep-link belongs to -- guard against regressions that
    // silently strip the aria-label.
    expect(link).toHaveAttribute(
      'aria-label',
      `Open run ${run.run_id} in chat`,
    );
  });

  it('hides Open-in-chat link when conversation_id is null (chat publishing disabled)', async () => {
    // Pre-IMP-13 / chat-publishing-off shape: the field is absent.
    const run = makeRun({ conversation_id: null });
    mockListRuns.mockResolvedValue([run]);

    render(<RunHistory taskId="t-1" />);

    const row = await screen.findByText(run.run_id);
    fireEvent.click(row);

    // Expanded panel rendered (response preview is visible) ...
    await screen.findByText(/all good/);
    // ... but the deep-link is intentionally absent.
    expect(screen.queryByTestId('run-chat-link')).toBeNull();
  });

  it('uses the per-run conversation_id (not a shared/static URL)', async () => {
    const runA = makeRun({
      run_id: 'r-A',
      conversation_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    });
    const runB = makeRun({
      run_id: 'r-B',
      conversation_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    });
    mockListRuns.mockResolvedValue([runA, runB]);

    render(<RunHistory taskId="t-1" />);

    fireEvent.click(await screen.findByText('r-A'));
    fireEvent.click(await screen.findByText('r-B'));

    await waitFor(() => {
      expect(screen.getAllByTestId('run-chat-link')).toHaveLength(2);
    });
    const links = screen.getAllByTestId('run-chat-link');
    const hrefs = links.map((l) => l.getAttribute('href'));
    expect(hrefs).toContain(`/chat/${runA.conversation_id}`);
    expect(hrefs).toContain(`/chat/${runB.conversation_id}`);
  });
});

describe('RunHistory webhook results', () => {
  it('renders the complete webhook response as markdown instead of the preview', async () => {
    const run = makeRun({
      conversation_id: null,
      response_preview: 'Short **preview**',
      response_full: '# Full result\n\n- first\n- second',
    });
    mockListRuns.mockResolvedValue([run]);

    render(<RunHistory taskId="t-1" triggerType="webhook" />);
    fireEvent.click(await screen.findByText(run.run_id));

    expect(screen.getByText('Result')).toBeInTheDocument();
    expect(screen.queryByText('Response preview')).not.toBeInTheDocument();
    expect(
      screen.getByTestId('webhook-run-result').querySelector('[data-testid="markdown-renderer"]'),
    ).toHaveTextContent(
      '# Full result - first - second',
    );
    expect(screen.queryByText('Short **preview**')).not.toBeInTheDocument();
  });

  it('falls back to the preview for webhook runs created before response_full existed', async () => {
    const run = makeRun({
      conversation_id: null,
      response_preview: '**Legacy result**',
      response_full: null,
    });
    mockListRuns.mockResolvedValue([run]);

    render(<RunHistory taskId="t-1" triggerType="webhook" />);
    fireEvent.click(await screen.findByText(run.run_id));

    expect(
      screen.getByTestId('webhook-run-result').querySelector('[data-testid="markdown-renderer"]'),
    ).toHaveTextContent('**Legacy result**');
  });

  it('keeps the compact preview for non-webhook runs', async () => {
    const run = makeRun({
      response_preview: 'Compact preview',
      response_full: '# Full scheduled result',
    });
    mockListRuns.mockResolvedValue([run]);

    render(<RunHistory taskId="t-1" triggerType="cron" />);
    fireEvent.click(await screen.findByText(run.run_id));

    expect(screen.getByText('Response preview')).toBeInTheDocument();
    expect(screen.getByText('Compact preview')).toBeInTheDocument();
    expect(screen.queryByTestId('markdown-renderer')).not.toBeInTheDocument();
  });
});

describe('RunHistory manual follow-up chats', () => {
  it.each(['cron', 'interval', 'webhook'] as const)(
    'opens a separate chat for either the older or latest %s run',
    async (triggerType) => {
      const older = makeRun({ run_id: 'older' });
      const latest = makeRun({ run_id: 'latest', started_at: '2026-04-20T10:00:00Z' });
      mockListRuns.mockResolvedValue([older, latest]);
      mockOpenChat.mockImplementation(async (_taskId, runId) => ({ conversation_id: runId + '-chat' }));
      render(<RunHistory taskId="t-1" triggerType={triggerType} allowFollowUp />);
      fireEvent.click(await screen.findByText('older'));
      fireEvent.click(screen.getByText('latest'));
      expect(screen.queryByRole('textbox')).toBeNull();
      const buttons = screen.getAllByRole('button', { name: 'Continue this run' });
      expect(buttons).toHaveLength(2);
      fireEvent.click(buttons[0]);
      await waitFor(() => expect(mockOpenChat).toHaveBeenCalledWith('t-1', 'latest'));
      expect(mockPush).toHaveBeenCalledWith('/chat/latest-chat');
      fireEvent.click(screen.getByRole('button', { name: 'Continue this run' }));
      await waitFor(() => expect(mockOpenChat).toHaveBeenCalledWith('t-1', 'older'));
      expect(mockPush).toHaveBeenCalledWith('/chat/older-chat');
    },
  );

  it('renders a persistent link to an existing private follow-up after reload', async () => {
    mockListRuns.mockResolvedValue([makeRun()]);
    mockListChats.mockResolvedValue({ 'r-1': 'manual-chat' });
    render(<RunHistory taskId="t-1" triggerType="webhook" allowFollowUp />);
    fireEvent.click(await screen.findByText('r-1'));
    expect(await screen.findByRole('link', { name: 'Open manual follow-up' })).toHaveAttribute('href', '/chat/manual-chat');
    expect(mockOpenChat).not.toHaveBeenCalled();
  });

  it('reports branch creation failures and allows retry', async () => {
    mockListRuns.mockResolvedValue([makeRun()]);
    mockOpenChat.mockRejectedValueOnce(new Error('Context unavailable')).mockResolvedValueOnce({ conversation_id: 'manual-chat' });
    render(<RunHistory taskId="t-1" triggerType="webhook" allowFollowUp />);
    fireEvent.click(await screen.findByText('r-1'));
    fireEvent.click(screen.getByRole('button', { name: 'Continue this run' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Context unavailable');
    expect(mockPush).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Continue this run' }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/chat/manual-chat'));
  });

  it.each([
    { status: 'running' as const },
    { status: 'pending' as const },
    { execution_context_id: null },
  ])('does not offer continuation for an unfinished or context-less run: %s', async (overrides) => {
    mockListRuns.mockResolvedValue([makeRun(overrides)]);
    render(<RunHistory taskId="t-1" triggerType="cron" allowFollowUp />);
    fireEvent.click(await screen.findByText('r-1'));
    expect(screen.queryByRole('button', { name: 'Continue this run' })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
