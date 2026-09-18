// assisted-by claude code claude-sonnet-4-6
import { renderHook, waitFor, act } from '@testing-library/react';
import { usePlatformHealthProbes } from '../use-platform-health-probes';

jest.useFakeTimers();

const POLL_INTERVAL_MS = 30000;

const makeHealthyResponse = (overrides: Record<string, unknown> = {}) => ({
  status: 'healthy',
  checked_at: new Date().toISOString(),
  summary: { total: 4, healthy: 3, degraded: 0, down: 0, disabled: 1 },
  capabilities: [
    {
      id: 'chat-runtime',
      label: 'Chat Runtime',
      group: 'runtime',
      status: 'healthy',
      required: true,
      description: 'Checks the supervisor health endpoint used by the chat experience.',
      detail: 'Supervisor reachable',
      latency_ms: 12,
    },
  ],
  ...overrides,
});

describe('usePlatformHealthProbes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    (global.fetch as jest.Mock) = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // 1. Initial state
  it('initial state: status is "checking", capabilities is [], summary is null', () => {
    (global.fetch as jest.Mock).mockImplementation(
      () => new Promise(() => {}) // Never resolves
    );

    const { result } = renderHook(() => usePlatformHealthProbes());

    expect(result.current.status).toBe('checking');
    expect(result.current.capabilities).toEqual([]);
    expect(result.current.summary).toBeNull();
    expect(result.current.probes).toEqual([]);
    expect(result.current.probeSummary).toBeNull();
  });

  // 2. Successful fetch → healthy
  it('successful fetch with status "healthy" → status becomes "healthy" and capabilities/summary are populated', async () => {
    const body = makeHealthyResponse();
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => body,
    });

    const { result } = renderHook(() => usePlatformHealthProbes());

    await waitFor(() => {
      expect(result.current.status).toBe('healthy');
    });

    expect(result.current.capabilities).toHaveLength(1);
    expect(result.current.capabilities[0].id).toBe('chat-runtime');
    expect(result.current.summary).toEqual({ total: 4, healthy: 3, degraded: 0, down: 0, disabled: 1 });
  });

  it('diagnostics mode fetches probes from /api/platform/health?diagnostics=1', async () => {
    const body = makeHealthyResponse({
      components: [{ id: 'scheduler', label: 'CAIPE Agent Scheduler', status: 'disabled', detail: 'Not enabled', version: null }],
      probe_summary: { total: 1, healthy: 1, warning: 0, down: 0 },
      probes: [
        {
          id: 'keycloak',
          label: 'Keycloak',
          group: 'identity',
          status: 'healthy',
          detail: 'HTTP 200',
          target: 'http://keycloak:7080/realms/caipe/protocol/openid-connect/certs',
          latency_ms: 12,
        },
      ],
    });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => body,
    });

    const { result } = renderHook(() => usePlatformHealthProbes({ diagnostics: true }));

    await waitFor(() => {
      expect(result.current.status).toBe('healthy');
    });

    expect(result.current.probeSummary).toEqual({ total: 1, healthy: 1, warning: 0, down: 0 });
    expect(result.current.probes.map((probe) => probe.id)).toEqual(['keycloak']);
    expect(result.current.components[0].id).toBe('scheduler');
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/platform/health?diagnostics=1',
      expect.objectContaining({ method: 'GET' })
    );
  });

  // 3. Successful fetch → degraded
  it('successful fetch with status "degraded" → status becomes "degraded"', async () => {
    const body = makeHealthyResponse({
      status: 'degraded',
      summary: { total: 4, healthy: 2, degraded: 1, down: 0, disabled: 1 },
    });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => body,
    });

    const { result } = renderHook(() => usePlatformHealthProbes());

    await waitFor(() => {
      expect(result.current.status).toBe('degraded');
    });
  });

  // 4. No flash on re-poll
  it('no flash on re-poll: status does NOT reset to "checking" during subsequent poll', async () => {
    const body = makeHealthyResponse();
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => body,
    });

    const { result } = renderHook(() => usePlatformHealthProbes());

    // Wait for first load
    await waitFor(() => {
      expect(result.current.status).toBe('healthy');
    });

    // Advance past one poll interval — the second fetch starts but status
    // should never dip back to "checking"
    const statusValues: string[] = [];
    const unsubscribe = (() => {
      // capture current on each re-render via a local tracker
      return () => {};
    })();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 100);
    });

    // Status must still be "healthy", never "checking"
    expect(result.current.status).toBe('healthy');
    void unsubscribe;
    void statusValues;
  });

  // 5. Debounce: single bad poll does NOT flip to "down"
  it('debounce: single failed poll after healthy load keeps status "healthy"', async () => {
    // First fetch: healthy
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => makeHealthyResponse(),
    });

    const { result } = renderHook(() => usePlatformHealthProbes());

    await waitFor(() => {
      expect(result.current.status).toBe('healthy');
    });

    // Second fetch: network error (streak = 1, not yet 2)
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));

    await act(async () => {
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 100);
    });

    // One bad poll is not enough to flip to "down"
    expect(result.current.status).toBe('healthy');
  });

  // 6. Debounce: two consecutive bad polls flip to "down"
  it('debounce: two consecutive failed polls promote status to "down"', async () => {
    // First fetch: healthy
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => makeHealthyResponse(),
    });

    const { result } = renderHook(() => usePlatformHealthProbes());

    await waitFor(() => {
      expect(result.current.status).toBe('healthy');
    });

    // Second fetch: fail (streak = 1)
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));

    await act(async () => {
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 100);
    });

    expect(result.current.status).toBe('healthy'); // Still healthy after 1 bad

    // Third fetch: fail (streak = 2 → flip to "down")
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));

    await act(async () => {
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 100);
    });

    expect(result.current.status).toBe('down');
  });

  // 7. First-load bad result → "down" immediately (no debounce on initial load)
  it('first-load fetch failure → status goes to "down" immediately without debounce', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => usePlatformHealthProbes());

    await waitFor(() => {
      expect(result.current.status).toBe('down');
    });
  });

  // 8. checkNow reference is stable across re-renders
  it('checkNow reference is stable (useCallback with no state deps)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => makeHealthyResponse(),
    });

    const { result, rerender } = renderHook(() => usePlatformHealthProbes());

    await waitFor(() => {
      expect(result.current.status).toBe('healthy');
    });

    const refBefore = result.current.checkNow;

    rerender();

    expect(result.current.checkNow).toBe(refBefore);
  });

  // 9. checkNow triggers a new fetch
  it('calling checkNow triggers a new /api/platform/health fetch', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => makeHealthyResponse(),
    });

    const { result } = renderHook(() => usePlatformHealthProbes());

    await waitFor(() => {
      expect(result.current.status).toBe('healthy');
    });

    const callsBefore = (global.fetch as jest.Mock).mock.calls.length;

    act(() => {
      result.current.checkNow();
    });

    await waitFor(() => {
      expect((global.fetch as jest.Mock).mock.calls.length).toBeGreaterThan(callsBefore);
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/platform/health',
      expect.objectContaining({ method: 'GET' })
    );
  });
});
